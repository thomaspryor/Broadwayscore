#!/usr/bin/env bash
# Integration test for BRO-4603: a phantom .git/shallow entry (a boundary SHA
# whose object never arrived) makes every fetch fail instantly with
#   fatal: error in object: unshallow <sha>
# and push-with-retry.sh used to spend every retry on that identical failure
# (card-verifiability-audit run 36999684962: 5/5; opening-night-express run
# 37190310392: 7/7). The fix heals the shallow file and retries the fetch.
#
# Real git end to end (no test double): the poisoned state is built the way it
# looks in CI, a depth-1 clone whose .git/shallow also names a deeper origin
# commit that is not in the local object store.
#
# Run: bash scripts/lib/push-with-retry.phantom-shallow.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
HEAL_LIB="$SCRIPT_DIR/heal-phantom-shallow.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

# ── Origin with enough history that a deeper commit exists ───────────────────
git init -q --bare "$TMP/origin.git"
git init -q "$TMP/seed"
for i in $(seq 1 8); do
  printf '{"n":%d}\n' "$i" > "$TMP/seed/f$i.json"
  gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m "seed $i"
done
gitc "$TMP/seed" branch -M main; gitc "$TMP/seed" push -q "$TMP/origin.git" main 2>/dev/null
PHANTOM=$(gitc "$TMP/seed" rev-parse HEAD~4)

# file:// is required: git ignores --depth for plain local paths.
git clone -q --depth=1 --no-tags --branch main "file://$TMP/origin.git" "$TMP/runner"
gitc "$TMP/runner" config user.email t@t.t; gitc "$TMP/runner" config user.name t
SHALLOW_FILE="$TMP/runner/$(gitc "$TMP/runner" rev-parse --git-path shallow)"
REAL_BOUNDARY=$(head -1 "$SHALLOW_FILE")

if [ "$(gitc "$TMP/runner" rev-parse --is-shallow-repository)" != "true" ]; then
  echo "FAIL[0]: fixture precondition — runner clone is not shallow ($(git --version)). Environment problem, not a push-with-retry regression."
  exit 1
fi

# ── heal_phantom_shallow is a no-op on a healthy shallow clone ───────────────
if ( cd "$TMP/runner" && source "$HEAL_LIB" && heal_phantom_shallow >/dev/null ); then
  echo "FAIL[1]: heal_phantom_shallow reported a heal on a healthy shallow file"; fail=1
else
  echo "PASS[1]: heal_phantom_shallow is a no-op when every entry has an object"
fi

# ── Poison .git/shallow the way CI ends up ───────────────────────────────────
echo "$PHANTOM" >> "$SHALLOW_FILE"

# A concurrent writer advances origin so the runner's first push is rejected.
printf '{"c":1}\n' > "$TMP/seed/other.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m concurrent-commit
gitc "$TMP/seed" push -q "$TMP/origin.git" main 2>/dev/null

# Precondition: the poisoned repo really fails the way production did. The
# fetch must reach back past the phantom: git 2.55 (the CI runners' version)
# only answers "unshallow <sha>" for a client-shallow commit inside the
# requested depth, so a --deepen=3 fetch succeeded there and this fixture read
# as unpoisoned (land run 37225868423). Verified on 2.43 and 2.55.
pre=$(gitc "$TMP/runner" fetch --deepen=20 origin main 2>&1); pre_rc=$?
if [ "$pre_rc" -eq 0 ] || ! grep -q "error in object: unshallow" <<<"$pre"; then
  echo "FAIL[2]: fixture precondition — a fetch in the poisoned clone did not fail with 'error in object: unshallow' (rc=$pre_rc): $pre"
  echo "         ($(git --version)) The assertions below would be vacuous."
  exit 1
fi
echo "PASS[2]: poisoned clone reproduces 'error in object: unshallow' (rc=$pre_rc)"

# ── heal refuses while another git holds shallow.lock ────────────────────────
touch "$SHALLOW_FILE.lock"
if ( cd "$TMP/runner" && source "$HEAL_LIB" && heal_phantom_shallow >/dev/null ); then
  echo "FAIL[3]: heal_phantom_shallow rewrote the file while shallow.lock existed"; fail=1
elif ! grep -qx "$PHANTOM" "$SHALLOW_FILE"; then
  echo "FAIL[3]: phantom entry vanished while shallow.lock existed"; fail=1
else
  echo "PASS[3]: heal_phantom_shallow leaves the file alone while shallow.lock exists"
fi
rm -f "$SHALLOW_FILE.lock"

# ── The runner commits and pushes through push-with-retry.sh ─────────────────
printf '{"run":1}\n' > "$TMP/runner/data.json"
gitc "$TMP/runner" add -A; gitc "$TMP/runner" commit -q -m "runner commit"

out=$(
  cd "$TMP/runner" && \
  GITHUB_ACTIONS=true \
  PUSH_API_FALLBACK_DISABLE=1 \
  PUSH_SKIP_UNSHALLOW=1 \
  GIT_NET_TIMEOUT_SEC=15 \
  PUSH_DEADLINE_SEC=90 \
  bash "$PUSH_SCRIPT" 3 main 2>&1
); code=$?

if ! grep -q "heal-phantom-shallow: removed" <<<"$out"; then
  echo "FAIL[4]: push-with-retry never healed the phantom shallow entry. Output:"; echo "$out" | sed 's/^/    /'; fail=1
else
  echo "PASS[4]: push-with-retry healed the phantom shallow entry"
fi

if grep -qx "$PHANTOM" "$SHALLOW_FILE" 2>/dev/null; then
  echo "FAIL[5]: phantom SHA still listed in .git/shallow after the push"; fail=1
elif [ -e "$SHALLOW_FILE.lock" ]; then
  echo "FAIL[5]: the heal left shallow.lock behind — every later shallow update in this repo would fail"; fail=1
else
  echo "PASS[5]: phantom SHA removed from .git/shallow, no shallow.lock left behind"
fi

if [ "$code" -ne 0 ]; then
  echo "FAIL[6]: push did not land (exit $code). Output:"; echo "$out" | sed 's/^/    /'; fail=1
else
  LANDED=$(git --git-dir="$TMP/origin.git" show main:data.json 2>/dev/null || echo "")
  CONCURRENT=$(git --git-dir="$TMP/origin.git" show main:other.json 2>/dev/null || echo "")
  if [ -n "$LANDED" ] && [ -n "$CONCURRENT" ]; then
    echo "PASS[6]: push landed on origin/main and kept the concurrent writer's commit"
  else
    echo "FAIL[6]: exit 0 but origin/main is missing the runner commit or the concurrent commit"; fail=1
  fi
fi

# The heal must not have touched the real boundary — ancestry checks depend on it.
if [ -n "$REAL_BOUNDARY" ] && ! gitc "$TMP/runner" cat-file -e "${REAL_BOUNDARY}^{commit}" 2>/dev/null; then
  echo "FAIL[7]: the original shallow boundary commit is no longer readable"; fail=1
else
  echo "PASS[7]: original shallow boundary commit still present"
fi

if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.phantom-shallow.test.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.phantom-shallow.test.sh PASSED ==="
