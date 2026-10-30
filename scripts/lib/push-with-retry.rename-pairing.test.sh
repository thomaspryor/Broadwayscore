#!/usr/bin/env bash
# BRO-6594 regression: git rename detection pairs UNRELATED, similar-looking
# pending stubs and turns two clean, disjoint additions into a rename/rename
# (1to2) conflict that no resolution arm settles.
#
# Live case (opening-night-poller run 41013824281, 2026-10-30): two concurrent
# poller runs both drained the same older stub (_pending/the-heart.../deadline)
# and each added a DIFFERENT new stub for another show (ours: financialtimes,
# remote: hollywood-reporter). Git saw "one deleted file, one similar added
# file" on each side and reported a rename/rename of the deleted stub to two
# destinations, writing the FT stub's content into the hollywood-reporter path.
# merge-pending-stub.js correctly refused ("stubs differ on url ... not the
# same review"), every strategy failed on all 20 attempts, and the run lost 29
# review files.
#
# Expected: the push lands, both new stubs exist on origin with their OWN
# content, and the drained stub stays deleted.
set -uo pipefail
export PUSH_FAILURE_LOG="${PUSH_FAILURE_LOG:-/dev/null}"
export DISK_PREFLIGHT_FLOOR_GB=0
export PUSH_API_FALLBACK_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

TMP=$(mktemp -d); [ -n "${KEEP_TMP:-}" ] && echo "TMP=$TMP"
trap '[ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
gitc() { git -C "$1" "${@:2}"; }

stub() { # url outlet show: the real _pending stub shape (mostly shared boilerplate)
  cat <<EOF
{
  "showId": "$3",
  "outletId": "$2",
  "outlet": "$2",
  "criticName": "Unknown",
  "url": "$1",
  "publishDate": null,
  "fullText": null,
  "isFullReview": false,
  "dtliExcerpt": null,
  "originalScore": null,
  "scoreSource": null,
  "assignedScore": null,
  "source": "opening-night-poller",
  "dtliThumb": null,
  "dtliUrl": null,
  "bwwExcerpt": null,
  "bwwRoundupUrl": null,
  "showScoreExcerpt": null,
  "contentTier": "stub",
  "contentTierReason": "No text content",
  "pendingReason": "no-byline",
  "firstSeenAt": "2026-10-30T06:00:00.000Z"
}
EOF
}

# Second, shorter stub shape: a different similarity ratio, so the pairing is
# exercised at more than one point of git's rename scoring.
short_stub() { printf '{\n  "showId": "%s",\n  "outletId": "%s",\n  "url": "%s",\n' "$3" "$2" "$1"; for k in a b c d e f g h i j k l m n o; do printf '  "%s": null,\n' "$k"; done; printf '  "z": 1\n}\n'; }

OLD=_pending/the-heart-off-broadway-2026/deadline--7fd7345c.json
THR=_pending/medea-off-broadway-2026/hollywood-reporter--2c44c6f9.json
FT=_pending/medea-off-broadway-2026/financialtimes--16b6f926.json

# run_case <label> <stub-fn>
run_case() {
  local label="$1" mk="$2" d="$TMP/$1"
  mkdir -p "$d"
  git init -q --bare "$d/origin.git"
  git init -q -b main "$d/seed"
  mkdir -p "$d/seed/$(dirname "$OLD")"
  "$mk" "https://deadline.com/2026/10/the-heart-review-1/" deadline the-heart-off-broadway-2026 > "$d/seed/$OLD"
  gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m seed; gitc "$d/seed" push -q "$d/origin.git" main 2>/dev/null
  git clone -q -b main "$d/origin.git" "$d/runner" 2>/dev/null

  # Remote (the other poller run): drains the old stub, adds the THR stub.
  gitc "$d/seed" rm -q "$OLD"; mkdir -p "$d/seed/$(dirname "$THR")"
  "$mk" "https://www.hollywoodreporter.com/lifestyle/lifestyle-news/medea-theater-review-1274662/" hollywood-reporter medea-off-broadway-2026 > "$d/seed/$THR"
  gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m remote-run; gitc "$d/seed" push -q "$d/origin.git" main 2>/dev/null

  # Ours: drains the same old stub, adds the FT stub.
  gitc "$d/runner" rm -q "$OLD"; mkdir -p "$d/runner/$(dirname "$FT")"
  "$mk" "https://www.ft.com/content/c29b7c78-ad3e-4e15-be61-0b9c25db1a19" financialtimes medea-off-broadway-2026 > "$d/runner/$FT"
  gitc "$d/runner" add -A; gitc "$d/runner" commit -q -m our-run

  # Precondition: plain git (what the script did before BRO-6594) really does
  # cross-wire this fixture, so the assertions below prove something.
  git clone -q -b main "$d/runner" "$d/probe" 2>/dev/null
  gitc "$d/probe" fetch -q "$d/origin.git" main 2>/dev/null
  local got probe_out
  if probe_out=$(gitc "$d/probe" rebase -X theirs FETCH_HEAD 2>&1); then
    if grep -q 'ft.com' "$d/probe/$THR" 2>/dev/null; then got=silent-crosswire; else got=clean; fi
  elif grep -q 'rename/rename' <<<"$probe_out"; then got=rename-conflict; else got=other-conflict; fi
  if [ "$got" = "silent-crosswire" ] || [ "$got" = "rename-conflict" ]; then
    echo "PASS[$label.0]: precondition: plain git rebase pairs the unrelated stubs ($got)"
  else
    echo "FAIL[$label.0]: plain git gives '$got' for this fixture, not a rename pairing; the test proves nothing"; fail=1
  fi

  local out code
  out=$( cd "$d/runner" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); code=$?
  [ -n "${VERBOSE:-}" ] && grep -E "rename-detection artifact|rename-crosswire:|BRO-6594|Rebase completed|Merge succeeded" <<<"$out" | sed "s/^/    [$label] /"
  show() { git --git-dir="$d/origin.git" show "main:$1" 2>/dev/null; }
  if [ "$code" -ne 0 ]; then
    echo "FAIL[$label.1]: expected exit 0, got $code. Last lines:"; echo "$out" | tail -25 | sed 's/^/    /'; fail=1
  else
    echo "PASS[$label.1]: push landed"
  fi
  if show "$FT" | grep -q 'ft.com'; then echo "PASS[$label.2]: our FT stub is on origin with its own url"
  else echo "FAIL[$label.2]: our FT stub missing or wrong on origin"; fail=1; fi
  if show "$THR" | grep -q 'hollywoodreporter.com' && ! show "$THR" | grep -q 'ft.com'; then
    echo "PASS[$label.3]: the remote's THR stub survived with its own url"
  else echo "FAIL[$label.3]: the remote's THR stub missing or overwritten on origin"; fail=1; fi
  if show "$OLD" >/dev/null; then echo "FAIL[$label.4]: the drained stub was resurrected"; fail=1
  else echo "PASS[$label.4]: the drained stub stays deleted"; fi
}

run_case full-stub stub
run_case short-stub short_stub

# Clean-rebase cross-wire (the post-success repair arm): the remote drains
# stub OLD and adds the unrelated THR stub; we only EDIT stub OLD. git reads
# the remote side as "OLD renamed to THR" and applies our edit to THR with NO
# conflict, so the remote's review silently gets our stub's fields.
d="$TMP/clean"; mkdir -p "$d"
git init -q --bare "$d/origin.git"; git init -q -b main "$d/seed"
mkdir -p "$d/seed/$(dirname "$OLD")"
stub "https://deadline.com/2026/10/the-heart-review-1/" deadline the-heart-off-broadway-2026 > "$d/seed/$OLD"
gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m seed; gitc "$d/seed" push -q "$d/origin.git" main 2>/dev/null
git clone -q -b main "$d/origin.git" "$d/runner" 2>/dev/null
gitc "$d/seed" rm -q "$OLD"; mkdir -p "$d/seed/$(dirname "$THR")"
stub "https://www.hollywoodreporter.com/lifestyle/lifestyle-news/medea-theater-review-1274662/" hollywood-reporter medea-off-broadway-2026 > "$d/seed/$THR"
gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m remote-run; gitc "$d/seed" push -q "$d/origin.git" main 2>/dev/null
THR_REMOTE=$(git --git-dir="$d/origin.git" rev-parse "main:$THR")
sed -i 's/"criticName": "Unknown"/"criticName": "Greg Evans"/' "$d/runner/$OLD"
gitc "$d/runner" commit -qam our-edit
git clone -q -b main "$d/runner" "$d/probe" 2>/dev/null; gitc "$d/probe" fetch -q "$d/origin.git" main 2>/dev/null
if gitc "$d/probe" rebase -q -X theirs FETCH_HEAD >/dev/null 2>&1 && grep -q 'Greg Evans' "$d/probe/$THR" 2>/dev/null; then
  echo "PASS[clean.0]: precondition: plain git rebase is clean AND writes our edit into the remote's THR stub"
else
  echo "FAIL[clean.0]: fixture no longer cross-wires cleanly under plain git; the test proves nothing"; fail=1
fi
out=$( cd "$d/runner" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); code=$?
[ -n "${VERBOSE:-}" ] && grep -E "rename-crosswire:|BRO-6594" <<<"$out" | sed "s/^/    [clean] /"
if [ "$code" -eq 0 ] && [ "$(git --git-dir="$d/origin.git" rev-parse "main:$THR" 2>/dev/null)" = "$THR_REMOTE" ]; then
  echo "PASS[clean.1]: push landed and the remote's THR stub is byte-identical to what the remote pushed"
else
  echo "FAIL[clean.1]: code=$code; THR on origin differs from the remote's version"; echo "$out" | tail -15 | sed 's/^/    /'; fail=1
fi

# Control: an unrelated concurrent push with no rename shape is untouched
# (the guard must be a no-op, no extra warning).
d="$TMP/control"; mkdir -p "$d"
git init -q --bare "$d/origin.git"; git init -q -b main "$d/seed"
echo '{"a":1}' > "$d/seed/a.json"; gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m seed; gitc "$d/seed" push -q "$d/origin.git" main 2>/dev/null
git clone -q -b main "$d/origin.git" "$d/runner" 2>/dev/null
echo '{"b":1}' > "$d/seed/b.json"; gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m remote; gitc "$d/seed" push -q "$d/origin.git" main 2>/dev/null
echo '{"a":2}' > "$d/runner/a.json"; gitc "$d/runner" commit -qam ours
out=$( cd "$d/runner" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); code=$?
if [ "$code" -eq 0 ] && ! grep -q 'rename-crosswire\|BRO-6594' <<<"$out" \
   && [ "$(git --git-dir="$d/origin.git" show main:a.json)" = '{"a":2}' ] \
   && [ "$(git --git-dir="$d/origin.git" show main:b.json)" = '{"b":1}' ]; then
  echo "PASS[control]: ordinary concurrent push lands with no cross-wire repair"
else
  echo "FAIL[control]: code=$code"; echo "$out" | tail -15 | sed 's/^/    /'; fail=1
fi

if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.rename-pairing.test.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.rename-pairing.test.sh PASSED ==="
