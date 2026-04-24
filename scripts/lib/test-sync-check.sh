#!/bin/bash
# Test harness for sync-review-texts.sh --check-only mode.
# Sets up a fake local + remote pair and exercises every state.

set -u

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/sync-review-texts.sh"
TESTS_PASSED=0
TESTS_FAILED=0

mktest() {
  local name="$1"
  local workdir
  workdir=$(mktemp -d)

  # Set up a bare "remote" + a clone as the local.
  git init --bare -q "$workdir/remote.git"
  git clone -q "$workdir/remote.git" "$workdir/local"
  cd "$workdir/local"
  git config user.email test@test
  git config user.name test
  echo "seed" > seed.txt
  git add seed.txt
  git commit -qm "seed"
  git push -q origin main 2>/dev/null || git push -q -u origin HEAD:main

  # Copy the sync script but rewrite REVIEW_TEXTS_DIR to point at our fake local.
  local testScript="$workdir/sync.sh"
  cp "$SCRIPT" "$testScript"
  sed -i '' "s|REVIEW_TEXTS_DIR=.*|REVIEW_TEXTS_DIR=\"$workdir/local\"|" "$testScript"
  chmod +x "$testScript"

  echo "$workdir|$testScript"
}

assert_state() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $name → $actual"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo "  FAIL: $name → actual=\"$actual\" expected=\"$expected\""
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
}

# Test 1: clean local, no divergence
test1() {
  IFS='|' read -r workdir script < <(mktest "clean")
  cd "$workdir/local"
  local out=$(bash "$script" --check-only)
  assert_state "clean" "$out" "state=clean behind=0 ahead=0 dirty=no"
  rm -rf "$workdir"
}

# Test 2: remote ahead by 3 commits, local clean
test2() {
  IFS='|' read -r workdir script < <(mktest "behind")
  # Simulate another machine pushing 3 commits to remote
  local other=$(mktemp -d)
  git clone -q "$workdir/remote.git" "$other/clone"
  cd "$other/clone"
  git config user.email o@o
  git config user.name o
  for i in 1 2 3; do
    echo "c$i" > "c$i.txt"
    git add "c$i.txt"
    git commit -qm "c$i"
  done
  git push -q origin main
  # Now the local is 3 behind
  cd "$workdir/local"
  local out=$(bash "$script" --check-only)
  assert_state "behind 3 commits" "$out" "state=behind behind=3 ahead=0 dirty=no"
  rm -rf "$workdir" "$other"
}

# Test 3: local ahead by 2 commits, remote clean (unpushed work)
test3() {
  IFS='|' read -r workdir script < <(mktest "ahead")
  cd "$workdir/local"
  for i in 1 2; do
    echo "local$i" > "local$i.txt"
    git add "local$i.txt"
    git commit -qm "local$i"
  done
  local out=$(bash "$script" --check-only)
  assert_state "ahead 2 commits" "$out" "state=ahead behind=0 ahead=2 dirty=no"
  rm -rf "$workdir"
}

# Test 4: diverged — local ahead by 1, remote ahead by 2
test4() {
  IFS='|' read -r workdir script < <(mktest "diverged")
  local other=$(mktemp -d)
  git clone -q "$workdir/remote.git" "$other/clone"
  cd "$other/clone"
  git config user.email o@o
  git config user.name o
  for i in 1 2; do
    echo "r$i" > "r$i.txt"
    git add "r$i.txt"
    git commit -qm "r$i"
  done
  git push -q origin main
  cd "$workdir/local"
  echo "locallocal" > lol.txt
  git add lol.txt
  git commit -qm "locallocal"
  local out=$(bash "$script" --check-only)
  assert_state "diverged 2 behind 1 ahead" "$out" "state=diverged behind=2 ahead=1 dirty=no"
  rm -rf "$workdir" "$other"
}

# Test 5: dirty — uncommitted working-tree changes
test5() {
  IFS='|' read -r workdir script < <(mktest "dirty-modified")
  cd "$workdir/local"
  echo "modified" >> seed.txt
  local out=$(bash "$script" --check-only)
  assert_state "dirty modified" "$out" "state=dirty behind=0 ahead=0 dirty=yes"
  rm -rf "$workdir"
}

# Test 6: dirty — untracked new file (not just modified tracked)
test6() {
  IFS='|' read -r workdir script < <(mktest "dirty-untracked")
  cd "$workdir/local"
  echo "new" > newfile.txt
  local out=$(bash "$script" --check-only)
  assert_state "dirty untracked" "$out" "state=dirty behind=0 ahead=0 dirty=yes"
  rm -rf "$workdir"
}

# Test 7: not a git repo
test7() {
  local workdir=$(mktemp -d)
  mkdir -p "$workdir/notarepo"
  local script="$workdir/sync.sh"
  cp "$SCRIPT" "$script"
  sed -i '' "s|REVIEW_TEXTS_DIR=.*|REVIEW_TEXTS_DIR=\"$workdir/notarepo\"|" "$script"
  chmod +x "$script"
  local out=$(bash "$script" --check-only)
  assert_state "not a git repo" "$out" "state=nogit behind=0 ahead=0 dirty=no"
  rm -rf "$workdir"
}

# Test 8: fetch fails (bad remote URL — should timeout or report nofetch)
test8() {
  IFS='|' read -r workdir script < <(mktest "nofetch")
  cd "$workdir/local"
  git remote set-url origin "https://127.0.0.1:1/bad.git"
  local start=$(date +%s)
  local out=$(bash "$script" --check-only 2>/dev/null)
  local end=$(date +%s)
  local elapsed=$((end - start))
  assert_state "fetch fail" "$out" "state=nofetch behind=0 ahead=0 dirty=no"
  if [ "$elapsed" -le 7 ]; then
    echo "  PASS: fetch-fail timing ${elapsed}s (≤7s)"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo "  FAIL: fetch-fail took ${elapsed}s (>7s)"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  rm -rf "$workdir"
}

# Test 9: exit code is always 0
test9() {
  IFS='|' read -r workdir script < <(mktest "exit-code")
  cd "$workdir/local"
  echo "dirty" >> seed.txt
  bash "$script" --check-only > /dev/null
  local ec=$?
  if [ "$ec" = "0" ]; then
    echo "  PASS: exit code 0 on dirty"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo "  FAIL: exit code was $ec"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  rm -rf "$workdir"
}

# Test 10: without --check-only, behavior unchanged (no new commits → "No review-texts changes")
test10() {
  IFS='|' read -r workdir script < <(mktest "backward-compat")
  cd "$workdir/local"
  local out=$(bash "$script" 2>&1 || true)
  if echo "$out" | grep -q "No review-texts changes to sync"; then
    echo "  PASS: --check-only not required, existing path unchanged"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo "  FAIL: existing path changed — out=\"$out\""
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  rm -rf "$workdir"
}

echo "Running sync-review-texts.sh --check-only tests..."
echo ""

test1
test2
test3
test4
test5
test6
test7
test8
test9
test10

echo ""
echo "═══════════════════════════════════════════════"
echo "  PASSED: $TESTS_PASSED"
echo "  FAILED: $TESTS_FAILED"
echo "═══════════════════════════════════════════════"

if [ "$TESTS_FAILED" -gt 0 ]; then
  exit 1
fi
