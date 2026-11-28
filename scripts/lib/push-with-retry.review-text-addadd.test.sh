#!/usr/bin/env bash
# BRO-6866 class guard. Opening-night-poller run 45298776421 (2026-11-24) lost
# 21 review files after 19 push attempts: both poller runs wrote the SAME review
# file (<show>/<outlet>--<critic>.json) with differing metadata, and ours also
# renamed the drained `--unknown` stub to it. Git reports rename/delete plus a
# both-sides-hold-the-path conflict that the generic `*` arm refuses (task #619:
# our blob differs), so every strategy failed. Expected: the push lands, both
# sides' fields survive (review-json-three-way-merge), the drained stub stays gone.
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

SHOW=a-christmas-carol-west-end-2026
OLD=$SHOW/london-theatre--unknown.json
NEW=$SHOW/london-theatre--suzy-evans.json

longtext() { for i in $(seq 1 40); do printf 'Paragraph %s of the remote run full review text, quite different from the stub. ' "$i"; done; }
review() { # criticName extra-key extra-value
  cat <<JSON
{
  "showId": "$SHOW",
  "outletId": "london-theatre",
  "outlet": "London Theatre",
  "criticName": "$1",
  "url": "https://www.londontheatre.co.uk/reviews/a-christmas-carol-review",
  "publishDate": "2026-11-20",
  "fullText": "A long review body that is mostly shared boilerplate between both runs of the poller, padded so similarity stays high enough for git to pair files.",
  "isFullReview": true,
  "source": "opening-night-poller",
  "contentTier": "complete",
  "$2": "$3"
}
JSON
}

d="$TMP/c"; mkdir -p "$d"
git init -q --bare "$d/broadway-review-texts.git"; git init -q -b main "$d/seed"
mkdir -p "$d/seed/$SHOW"; review Unknown seedKey s > "$d/seed/$OLD"
gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m seed; gitc "$d/seed" push -q "$d/broadway-review-texts.git" main 2>/dev/null
git clone -q -b main "$d/broadway-review-texts.git" "$d/runner" 2>/dev/null
# Remote runs: one writes the named file with its own metadata, a later one
# drains the stub (separate commits, as on main in the live run).
mkdir -p "$d/seed/$SHOW"; review "Suzy Evans" remoteOnly R | sed "s|\"fullText\": \".*\"|\"fullText\": \"$(longtext)\"|" > "$d/seed/$NEW"
gitc "$d/seed" add -A; gitc "$d/seed" commit -q -m remote-named
gitc "$d/seed" rm -q "$OLD"; gitc "$d/seed" commit -q -m remote-drain
gitc "$d/seed" push -q "$d/broadway-review-texts.git" main 2>/dev/null
# Our run: renames the stub to the same named file with different metadata.
gitc "$d/runner" mv "$OLD" "$NEW"; review "Suzy Evans" ourOnly O > "$d/runner/$NEW"
gitc "$d/runner" add -A; gitc "$d/runner" commit -q -m our-run

out=$( cd "$d/runner" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); code=$?
show() { git --git-dir="$d/broadway-review-texts.git" show "main:$1" 2>/dev/null; }
[ -n "${VERBOSE:-}" ] && echo "$out" | tail -30 | sed 's/^/    /'
if [ "$code" -eq 0 ]; then echo "PASS[1]: push landed"; else echo "FAIL[1]: exit $code"; echo "$out" | tail -25 | sed 's/^/    /'; fail=1; fi
if show "$NEW" | grep -q '"remoteOnly"' && show "$NEW" | grep -q '"ourOnly"'; then echo "PASS[2]: both runs' fields survive in the named file"
else echo "FAIL[2]: merged file lacks one side's field"; fail=1; fi
if show "$OLD" >/dev/null; then echo "FAIL[3]: drained stub resurrected"; fail=1; else echo "PASS[3]: drained stub stays deleted"; fi

# Merge mode: `git merge` leaves ours at stage 2 and the remote at stage 3, the
# reverse of a rebase. --swap-stages must still keep both sides' fields and
# let the remote (upstream) side win a true tie.
m="$TMP/m"; mkdir -p "$m"; git init -q -b main "$m/r"
mkdir -p "$m/r/$SHOW"; review Unknown seedKey s > "$m/r/$OLD"
gitc "$m/r" add -A; gitc "$m/r" commit -q -m seed
gitc "$m/r" checkout -q -b remote; review "Suzy Evans" remoteOnly R > "$m/r/$NEW"; gitc "$m/r" add -A; gitc "$m/r" commit -q -m remote
gitc "$m/r" checkout -q main; review "Suzy Evans" ourOnly O > "$m/r/$NEW"; gitc "$m/r" add -A; gitc "$m/r" commit -q -m ours
gitc "$m/r" merge -q remote >/dev/null 2>&1
( cd "$m/r" && node "$SCRIPT_DIR/review-json-three-way-merge.js" --only="$NEW" --tie=upstream --swap-stages >/dev/null 2>&1 )
if [ -z "$(git -C "$m/r" ls-files -u -- "$NEW")" ] && grep -q '"remoteOnly"' "$m/r/$NEW" && grep -q '"ourOnly"' "$m/r/$NEW"; then echo "PASS[4]: merge-mode (--swap-stages) keeps both sides"
else echo "FAIL[4]: merge-mode field merge"; fail=1; fi
exit $fail
