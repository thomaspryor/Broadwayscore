#!/usr/bin/env bash
# Integration test for BRO-4219: push-with-retry.sh on a BLOBLESS PARTIAL CLONE
# (actions/checkout `fetch-depth: 0` + `filter: blob:none`).
#
# Why the poller moved to a partial clone: its full-history checkout of this
# repo took 21m13s of a 34-min pass (run 36439166445, 2026-09-28) because
# fetch-depth: 0 transfers every historical blob of every data/*.json rewrite.
# `filter: blob:none` keeps the FULL commit graph (still required — the #209
# incident, 53ff06a4a7a: a depth-1 checkout let the rebase/merge/reset path mint
# a parentless root commit) but defers blob content to on-demand fetches. Same
# checkout land.yml and autonomous-merge.yml already use (BRO-423): 38s.
#
# What a promisor clone changes for THIS script (scripts/lib/land-branch.js
# hit it first, run 36351955579): mid-rebase git lazily fetches missing blobs
# in batches, and a batch can name a blob the rebase itself just wrote — GitHub
# answers `not our ref`, the batch dies, and the rebase fails with NO conflict.
# Untreated, _rebase_with_captured_stderr would file that as "Rebase had
# conflicts" and fall through to `git merge -X ours` (the BRO-3662 shape),
# changing topology over a transient fetch error. The fix retries a rebase
# that dies that way (a fresh process sees the blobs the failed pass wrote),
# mirroring land-branch.js's rebaseOnto, with the classifier shared through
# scripts/lib/promisor-fetch-failure.js.
#
# Cases:
#   1. Three consecutive passes from a blobless runner under churn (a writer
#      advances origin after every local commit, editing the SAME json file,
#      so every rebase lazily fetches the writer's blobs): every pass lands
#      clean (no fallback path), both sides survive, origin keeps ONE root
#      (the #209 invariant). NOTE: a local bare origin never answers
#      `not our ref`, so this case proves the ordinary blobless path, not the
#      hazard — case 2 injects the hazard's stderr.
#   2. Fault injection: the FIRST `git rebase -X theirs` prints the verbatim
#      Land stderr and exits 128 without starting a rebase — the script must
#      retry the rebase (not take the merge fallback) and land.
#   3. Over-fire guard: a genuine `CONFLICT (content)` stderr must NOT trigger
#      the promisor retry (it exits through the pre-existing BRO-3662 path).
#   4. A plain (non-promisor) clone fed the SAME promisor stderr never retries
#      — the gate holds for the ~130 workflows that push through this helper.
#   5. PUSH_SKIP_PROMISOR_RETRY=1 (kill switch) restores the pre-BRO-4219 flow
#      on a promisor clone.
#
# Run: bash scripts/lib/push-with-retry.partial-clone.integration.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# Keep every run hermetic: no cross-session mutex, no failure ledger, no
# Git Data API fallback (a hermetic bare origin has no GitHub API).
export PUSH_FAILURE_LOG="$TMP/failures.jsonl" PUSH_API_FALLBACK_DISABLE=1 PUSH_SKIP_LEDGER=1

gitc() { git -C "$1" "${@:2}"; }
REAL_GIT_BIN="$(command -v git)"

# 40-line JSON-ish file so a writer edit at the top and a runner edit at the
# bottom 3-way merge cleanly — which is exactly when git must READ both sides'
# blobs (the lazy-fetch moment on a promisor clone), not just pick one.
body() {  # body <top-tag> <bottom-tag>
  echo "{"
  echo "  \"top\": \"$1\","
  for i in $(seq 1 37); do echo "  \"k$i\": $i,"; done
  echo "  \"bottom\": \"$2\""
  echo "}"
}

# ── Bare origin that serves partial clones the way GitHub does ────────────────
make_origin() {  # make_origin <dir>
  git init -q --bare "$1"
  gitc "$1" config uploadpack.allowFilter true
  gitc "$1" config uploadpack.allowAnySHA1InWant true
}
seed_origin() {  # seed_origin <origin> <seeddir>
  git init -q "$2"
  gitc "$2" config user.email t@t; gitc "$2" config user.name t
  mkdir -p "$2/data/audit"
  body base base > "$2/data/audit/ledger.json"
  printf '{"n":0}\n' > "$2/other.json"
  gitc "$2" add -A; gitc "$2" commit -q -m seed
  gitc "$2" branch -M main; gitc "$2" push -q "$1" main
}
# Runner = what actions/checkout produces with fetch-depth: 0 + filter: blob:none.
# --no-local is required: a plain local-path clone hardlinks the objects and
# silently ignores the filter, so nothing would be missing.
clone_partial() {  # clone_partial <origin> <dir>
  git clone -q --no-local --filter=blob:none --branch main "file://$1" "$2"
  gitc "$2" config user.email t@t; gitc "$2" config user.name t
}
# Every lazy fetch from a promisor remote lands as a pack with a `.promisor`
# marker — counting those is how the test proves a rebase actually pulled
# blobs on demand rather than having them all locally.
promisor_packs() {  # promisor_packs <repo>
  # --path-format=absolute: a bare --git-path answer is relative to the repo,
  # and this runs from the test's own cwd.
  find "$(gitc "$1" rev-parse --path-format=absolute --git-path objects/pack)" -name '*.promisor' 2>/dev/null | wc -l | tr -d ' '
}
root_count() {  # root_count <bare-origin>
  git --git-dir="$1" rev-list --max-parents=0 main | wc -l | tr -d ' '
}

# ── Case 1: three consecutive passes under churn from a blobless runner ──────
make_origin "$TMP/o1.git"; seed_origin "$TMP/o1.git" "$TMP/w1"
clone_partial "$TMP/o1.git" "$TMP/r1"
if [ "$(gitc "$TMP/r1" config --get remote.origin.promisor)" != "true" ] \
   || [ "$(gitc "$TMP/r1" rev-parse --is-shallow-repository)" != "false" ]; then
  echo "FAIL[1]: fixture is not a promisor (non-shallow) clone — promisor='$(gitc "$TMP/r1" config --get remote.origin.promisor)' shallow='$(gitc "$TMP/r1" rev-parse --is-shallow-repository)'"; fail=1
fi
case1_ok=true
for pass in 1 2 3; do
  # Runner edits the bottom of the ledger and commits (the "Commit …" step).
  top_now=$(grep '"top"' "$TMP/r1/data/audit/ledger.json" | sed 's/.*: "\(.*\)",/\1/')
  body "$top_now" "runner-$pass" > "$TMP/r1/data/audit/ledger.json"
  gitc "$TMP/r1" add -A; gitc "$TMP/r1" commit -q -m "runner pass $pass"
  # A concurrent writer advances origin AFTER that commit: same file, top line,
  # plus an unrelated file — so the rebase needs the writer's NEW blobs, which
  # the partial clone does not have.
  gitc "$TMP/w1" fetch -q origin main 2>/dev/null || gitc "$TMP/w1" fetch -q "$TMP/o1.git" main
  gitc "$TMP/w1" reset -q --hard FETCH_HEAD
  bottom_now=$(grep '"bottom"' "$TMP/w1/data/audit/ledger.json" | sed 's/.*: "\(.*\)"/\1/')
  body "writer-$pass" "$bottom_now" > "$TMP/w1/data/audit/ledger.json"
  printf '{"n":%d}\n' "$pass" > "$TMP/w1/other.json"
  gitc "$TMP/w1" add -A; gitc "$TMP/w1" commit -q -m "writer pass $pass"
  gitc "$TMP/w1" push -q "$TMP/o1.git" HEAD:main
  packs_before=$(promisor_packs "$TMP/r1")

  out=$( cd "$TMP/r1" && bash "$PUSH_SCRIPT" 5 main 2>&1 ); code=$?
  packs_after=$(promisor_packs "$TMP/r1")
  landed=$(git --git-dir="$TMP/o1.git" show main:data/audit/ledger.json 2>/dev/null || echo "")
  if [ "$code" -ne 0 ]; then
    echo "FAIL[1.$pass]: expected exit 0, got $code. Output:"; echo "$out" | sed 's/^/    /'; case1_ok=false; break
  elif ! grep -q "\"top\": \"writer-$pass\"" <<<"$landed" || ! grep -q "\"bottom\": \"runner-$pass\"" <<<"$landed"; then
    echo "FAIL[1.$pass]: origin ledger lost a side — writer-$pass / runner-$pass expected. origin now:"; echo "$landed" | sed 's/^/    /'; case1_ok=false; break
  elif grep -q "partial-clone lazy-fetch failure" <<<"$out"; then
    echo "FAIL[1.$pass]: the promisor retry fired on a clean rebase against a local origin. Output:"; echo "$out" | sed 's/^/    /'; case1_ok=false; break
  elif grep -q "Trying merge fallback\|Rebase had conflicts" <<<"$out"; then
    echo "FAIL[1.$pass]: a clean 3-way merge took a fallback path. Output:"; echo "$out" | sed 's/^/    /'; case1_ok=false; break
  elif [ "$(root_count "$TMP/o1.git")" != "1" ]; then
    echo "FAIL[1.$pass]: origin/main now has $(root_count "$TMP/o1.git") root commits — the #209 parentless-root corruption regressed"; case1_ok=false; break
  elif [ "$(git --git-dir="$TMP/o1.git" show main:other.json)" != "{\"n\":$pass}" ]; then
    echo "FAIL[1.$pass]: the writer's unrelated file did not survive the rebase"; case1_ok=false; break
  elif [ $((packs_after - packs_before)) -lt 2 ]; then
    # The script's own pre-rebase `git fetch` from a promisor remote writes
    # ONE .promisor pack with no lazy read; the rebase's lazy blob fetch is
    # the second. Fewer than two means the rebase read nothing on demand.
    echo "FAIL[1.$pass]: expected >=2 new promisor packs (fetch + lazy blob read), got $packs_before -> $packs_after — the rebase never lazily fetched, so this pass did not exercise a partial clone (fixture bug: is the clone really blobless?)"; case1_ok=false; break
  else
    echo "  pass $pass: landed on top of the writer (lazy-fetched promisor packs: $packs_before -> $packs_after)"
  fi
done
[ "$case1_ok" = "true" ] && echo "PASS[1]: three consecutive pushes from a blobless clone landed under churn, one root, both sides intact, no fallback path"

# ── Fault-injection `git` double: the FIRST `git rebase -X …` call fails with
# a caller-supplied stderr and rc, without starting a rebase; everything else
# (including the script's own `git rebase --abort`) proxies to the real git.
# The script resolves `git` from PATH, so this intercepts exactly the call
# _rebase_with_captured_stderr makes; git's internal promisor-fetch child is
# exec'd by path, never via PATH, so it is untouched.
make_fake_git() {  # make_fake_git <bindir> <stderr-text> <rc>
  mkdir -p "$1"
  printf '%s\n' "$2" > "$1/stderr.txt"
  cat > "$1/git" <<WRAPPER
#!/usr/bin/env bash
if [ "\${1:-}" = "rebase" ] && [ "\${2:-}" = "-X" ] && [ ! -f "$1/fired" ]; then
  : > "$1/fired"
  cat "$1/stderr.txt" >&2
  exit $3
fi
exec "$REAL_GIT_BIN" "\$@"
WRAPPER
  chmod +x "$1/git"
}
# One origin + partial runner + a writer commit ahead of it, so the push is
# rejected and the fetch+rebase path actually runs.
race_fixture() {  # race_fixture <n>  → $TMP/o<n>.git, $TMP/r<n>
  make_origin "$TMP/o$1.git"; seed_origin "$TMP/o$1.git" "$TMP/w$1"
  clone_partial "$TMP/o$1.git" "$TMP/r$1"
  body base "runner" > "$TMP/r$1/data/audit/ledger.json"
  gitc "$TMP/r$1" add -A; gitc "$TMP/r$1" commit -q -m "runner"
  body writer base > "$TMP/w$1/data/audit/ledger.json"
  gitc "$TMP/w$1" commit -q -am "writer"; gitc "$TMP/w$1" push -q "$TMP/o$1.git" HEAD:main
}

# ── Case 2: the real Land stderr → retry the rebase, never the merge fallback ─
race_fixture 2
make_fake_git "$TMP/fake2" \
  'fatal: remote error: upload-pack: not our ref e31a1e453a95c0ffee
fatal: could not fetch bc4a5adf from promisor remote' 128
out2=$( cd "$TMP/r2" && PATH="$TMP/fake2:$PATH" bash "$PUSH_SCRIPT" 5 main 2>&1 ); code2=$?
landed2=$(git --git-dir="$TMP/o2.git" show main:data/audit/ledger.json 2>/dev/null || echo "")
if [ "$code2" -ne 0 ]; then
  echo "FAIL[2]: expected exit 0 after the promisor retry, got $code2. Output:"; echo "$out2" | sed 's/^/    /'; fail=1
elif [ ! -f "$TMP/fake2/fired" ]; then
  echo "FAIL[2]: the fault never fired — the wrapper did not intercept the rebase call (fixture bug)"; fail=1
elif ! grep -q "partial-clone lazy-fetch failure" <<<"$out2"; then
  echo "FAIL[2]: rebase died with the promisor stderr but no retry warning was logged. Output:"; echo "$out2" | sed 's/^/    /'; fail=1
elif grep -q "Trying merge fallback\|rebase REFUSED before it started" <<<"$out2"; then
  echo "FAIL[2]: a lazy-fetch failure fell through to the merge/refusal path instead of retrying the rebase. Output:"; echo "$out2" | sed 's/^/    /'; fail=1
elif ! grep -q '"top": "writer"' <<<"$landed2" || ! grep -q '"bottom": "runner"' <<<"$landed2"; then
  echo "FAIL[2]: retry landed but a side was lost. origin now:"; echo "$landed2" | sed 's/^/    /'; fail=1
elif [ "$(root_count "$TMP/o2.git")" != "1" ]; then
  echo "FAIL[2]: origin/main has $(root_count "$TMP/o2.git") roots after the retry"; fail=1
else
  echo "PASS[2]: a promisor lazy-fetch failure retried the rebase (not the merge fallback) and landed on top of the writer"
fi

# ── Case 3: a genuine conflict must NOT be masked by the promisor retry ───────
race_fixture 3
make_fake_git "$TMP/fake3" \
  'CONFLICT (content): Merge conflict in data/audit/ledger.json
error: could not apply 1234567... runner
fatal: not our ref abc' 1
out3=$( cd "$TMP/r3" && PATH="$TMP/fake3:$PATH" bash "$PUSH_SCRIPT" 5 main 2>&1 ); code3=$?
if [ ! -f "$TMP/fake3/fired" ]; then
  echo "FAIL[3]: the fault never fired (fixture bug)"; fail=1
elif grep -q "partial-clone lazy-fetch failure" <<<"$out3"; then
  echo "FAIL[3]: a real CONFLICT stderr was classified as a lazy-fetch failure — the retry over-fires. Output:"; echo "$out3" | sed 's/^/    /'; fail=1
elif [ "$code3" -ne 0 ]; then
  # The fake refusal left no rebase state; the pre-existing BRO-3662 path
  # (refusal → merge fallback) is what handles it, and it must still land.
  echo "FAIL[3]: conflict stderr took the retry-free path but the push did not land (exit $code3). Output:"; echo "$out3" | sed 's/^/    /'; fail=1
else
  echo "PASS[3]: a genuine conflict stderr never triggers the promisor retry (existing paths handled it)"
fi

# ── Case 4: a plain clone never retries, even on the promisor stderr ─────────
git init -q --bare "$TMP/o4.git"; seed_origin "$TMP/o4.git" "$TMP/w4"
git clone -q --branch main "$TMP/o4.git" "$TMP/r4"
gitc "$TMP/r4" config user.email t@t; gitc "$TMP/r4" config user.name t
if [ "$(gitc "$TMP/r4" config --get remote.origin.promisor 2>/dev/null || true)" = "true" ]; then
  echo "FAIL[4]: fixture is unexpectedly a promisor clone"; fail=1
fi
body base "runner" > "$TMP/r4/data/audit/ledger.json"
gitc "$TMP/r4" add -A; gitc "$TMP/r4" commit -q -m "runner"
body writer base > "$TMP/w4/data/audit/ledger.json"
gitc "$TMP/w4" commit -q -am "writer"; gitc "$TMP/w4" push -q "$TMP/o4.git" HEAD:main
make_fake_git "$TMP/fake4" \
  'fatal: remote error: upload-pack: not our ref e31a1e453a95c0ffee
fatal: could not fetch bc4a5adf from promisor remote' 128
out4=$( cd "$TMP/r4" && PATH="$TMP/fake4:$PATH" bash "$PUSH_SCRIPT" 5 main 2>&1 ); code4=$?
if [ ! -f "$TMP/fake4/fired" ]; then
  echo "FAIL[4]: the fault never fired (fixture bug)"; fail=1
elif grep -q "partial-clone lazy-fetch failure" <<<"$out4"; then
  echo "FAIL[4]: the promisor retry fired on a NON-promisor clone — the gate is broken for every ordinary caller. Output:"; echo "$out4" | sed 's/^/    /'; fail=1
elif ! grep -q "rebase REFUSED before it started" <<<"$out4"; then
  echo "FAIL[4]: on a plain clone the same stderr must still take the pre-existing BRO-3662 refusal path. Output:"; echo "$out4" | sed 's/^/    /'; fail=1
elif [ "$code4" -ne 0 ]; then
  echo "FAIL[4]: plain-clone push did not land through the existing paths (exit $code4). Output:"; echo "$out4" | sed 's/^/    /'; fail=1
else
  echo "PASS[4]: a plain clone takes the unchanged path — no promisor retry, existing refusal handling, push landed"
fi

# ── Case 5: kill switch — PUSH_SKIP_PROMISOR_RETRY=1 restores the old flow ───
race_fixture 5
make_fake_git "$TMP/fake5" \
  'fatal: remote error: upload-pack: not our ref e31a1e453a95c0ffee
fatal: could not fetch bc4a5adf from promisor remote' 128
out5=$( cd "$TMP/r5" && PATH="$TMP/fake5:$PATH" PUSH_SKIP_PROMISOR_RETRY=1 bash "$PUSH_SCRIPT" 5 main 2>&1 ); code5=$?
if [ ! -f "$TMP/fake5/fired" ]; then
  echo "FAIL[5]: the fault never fired (fixture bug)"; fail=1
elif grep -q "partial-clone lazy-fetch failure" <<<"$out5"; then
  echo "FAIL[5]: PUSH_SKIP_PROMISOR_RETRY=1 did not disable the retry. Output:"; echo "$out5" | sed 's/^/    /'; fail=1
elif ! grep -q "rebase REFUSED before it started" <<<"$out5" || [ "$code5" -ne 0 ]; then
  echo "FAIL[5]: with the kill switch the pre-BRO-4219 path must run and land (exit $code5). Output:"; echo "$out5" | sed 's/^/    /'; fail=1
else
  echo "PASS[5]: PUSH_SKIP_PROMISOR_RETRY=1 takes the pre-existing path on a promisor clone (no retry, still landed)"
fi

if [ "$case1_ok" != "true" ]; then fail=1; fi
if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.partial-clone.integration.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.partial-clone.integration.sh PASSED ==="
