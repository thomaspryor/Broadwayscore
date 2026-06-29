#!/usr/bin/env bash
# Integration test for the pre-push conflict-marker guard in push-with-retry.sh.
# Sets up a throwaway git repo, stages a file containing a git conflict marker, runs
# push-with-retry.sh, and asserts it ABORTS with the conflict-marker error before any
# real push — the root-cause fix for the committed-marker corruption that broke
# validate-review-texts (Notion 38e637c5). Also asserts a clean staged file passes the
# guard. Run: bash scripts/lib/push-with-retry.conflict-marker.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

setup_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
}

# --- Case 1: staged file WITH a conflict marker must be rejected ---
TMP1=$(mktemp -d)
trap 'rm -rf "$TMP1" "${TMP2:-}"' EXIT
setup_repo "$TMP1"
printf '{\n<<<<<<<< HEAD:_pending/relics-west-end-2026/times-uk--61f17567.json\n  "showId": "relics-west-end-2026"\n}\n' > "$TMP1/review.json"
git -C "$TMP1" add review.json
# Run the guard from inside the repo. The guard runs before any push attempt, so a
# missing remote does not mask it. Capture combined output + exit code.
out=$( cd "$TMP1" && bash "$PUSH_SCRIPT" 1 main 2>&1 ); code=$?
if [ "$code" -ne 1 ]; then
  echo "FAIL[1]: expected exit 1 on conflict-marker file, got $code"; fail=1
elif ! grep -q "unresolved git conflict markers" <<<"$out"; then
  echo "FAIL[1]: exit 1 but missing conflict-marker error message. Output:"; echo "$out"; fail=1
else
  echo "PASS[1]: conflict-marker file rejected before push"
fi

# --- Case 2: clean staged file passes the guard (PUSH_SKIP would mask it; we instead
#     assert the guard message is ABSENT — the push then fails on the bogus remote,
#     which is fine; we only care that the guard did not fire) ---
TMP2=$(mktemp -d)
setup_repo "$TMP2"
printf '{\n  "showId": "relics-west-end-2026",\n  "score": 88\n}\n' > "$TMP2/review.json"
git -C "$TMP2" add review.json
out2=$( cd "$TMP2" && bash "$PUSH_SCRIPT" 1 main 2>&1 ); code2=$?
if grep -q "unresolved git conflict markers" <<<"$out2"; then
  echo "FAIL[2]: guard false-positived on a clean file. Output:"; echo "$out2"; fail=1
else
  echo "PASS[2]: clean file passed the conflict-marker guard"
fi

if [ "$fail" -ne 0 ]; then
  echo "conflict-marker guard test: FAILED"; exit 1
fi
echo "conflict-marker guard test: OK"
