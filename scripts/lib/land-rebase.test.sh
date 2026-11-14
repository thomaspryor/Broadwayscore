#!/usr/bin/env bash
# Integration test for land-rebase.sh (BRO-4165): a rebase that dies on a
# partial-clone lazy fetch is retried and reported apart from a real conflict.
# Real git repos + the REAL classifier (promisor-fetch-failure.js); a PATH shim
# stands in for git only to inject the promisor stderr on `git rebase <base>`
# (a real "not our ref" needs GitHub). Run: bash scripts/lib/land-rebase.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/land-rebase.sh"
REAL_GIT="$(command -v git)"
fail=0
ok()  { echo "  ok: $1"; }
bad() { echo "  FAIL: $1"; fail=1; }

T="$(mktemp -d "${TMPDIR:-/tmp}/land-rebase-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/shim"
cat > "$T/shim/git" <<SHIM
#!/usr/bin/env bash
# Fail the first \$SHIM_FAILS \`git rebase <base>\` calls with \$SHIM_STDERR.
if [ "\${1:-}" = rebase ] && [ "\${2:-}" != --abort ] && [ -n "\${SHIM_FAILS:-}" ]; then
  n=\$(cat "\$SHIM_COUNT" 2>/dev/null || echo 0)
  if [ "\$n" -lt "\$SHIM_FAILS" ]; then
    echo \$((n + 1)) > "\$SHIM_COUNT"
    printf '%s\n' "\$SHIM_STDERR" >&2
    exit 128
  fi
fi
exec "$REAL_GIT" "\$@"
SHIM
chmod +x "$T/shim/git"

# Repo: main has c1 + m1 (touches a.txt); branch forked at c1 with b1 (b.txt).
mkrepo() {
  local d="$T/$1"; rm -rf "$d"; mkdir -p "$d"; cd "$d" || exit 1
  git init -q . && git checkout -q -b main && git config user.email t@t && git config user.name t
  echo one > a.txt && git add . && git commit -qm c1
  git checkout -qb land/x
  echo branch > "${2:-b.txt}" && git add . && git commit -qm b1
  git checkout -q main
  echo main > a.txt && git commit -qam m1
  git checkout -q land/x
  BASE="$(git rev-parse main)"
}
run() { # <fails> <stderr> -> sets OUT, RC
  echo 0 > "$T/count"
  OUT="$(SHIM_FAILS="$1" SHIM_STDERR="$2" SHIM_COUNT="$T/count" PATH="$T/shim:$PATH" BRANCH=land/x bash "$SUT" "$BASE" land/x 2>&1)"
  RC=$?
}
PROM=$'fatal: remote error: upload-pack: not our ref fa828130c70d744dcd88936417660efb8eaf771c\nfatal: could not fetch 04e17cbce3882a3bdc27b7ee1aeeabb43799257b from promisor remote'

echo "case 1: clean rebase"
mkrepo r1; run 0 ""
[ $RC -eq 0 ] && [ "$(git rev-parse HEAD~1)" = "$BASE" ] && ok "rebased onto base" || bad "rc=$RC $OUT"

echo "case 2: promisor failure twice, then success"
mkrepo r2; run 2 "$PROM"
[ $RC -eq 0 ] && [ "$(git rev-parse HEAD~1)" = "$BASE" ] && grep -q 'retry 2/3' <<<"$OUT" && ok "retried to success" || bad "rc=$RC $OUT"
[ ! -d .git/rebase-merge ] && ok "no rebase state left" || bad "rebase-merge left"

echo "case 3: promisor failure never clears"
mkrepo r3; run 99 "$PROM"
[ $RC -eq 3 ] && grep -q 'NOT a merge conflict' <<<"$OUT" && ! grep -q 'resolve the conflict' <<<"$OUT" && ok "exit 3, classified as infra" || bad "rc=$RC $OUT"

echo "case 4: real conflict is not retried"
mkrepo r4 a.txt; run 0 ""
[ $RC -eq 1 ] && grep -q 'resolve the conflict' <<<"$OUT" && ! grep -q 'lazy-fetch' <<<"$OUT" && ok "exit 1, conflict message" || bad "rc=$RC $OUT"
[ ! -d .git/rebase-merge ] && ok "aborted cleanly" || bad "rebase-merge left"

echo "case 5: promisor text alongside CONFLICT stays a conflict"
mkrepo r5; run 1 "$PROM"$'\nCONFLICT (content): Merge conflict in a.txt'
[ $RC -eq 1 ] && grep -q 'resolve the conflict' <<<"$OUT" && ok "conflict wins" || bad "rc=$RC $OUT"

echo "case 6: a stale DEPENDENCIES.md is regenerated into the last branch commit (BRO-7150)"
mkrepo r6
mkdir -p scripts .github/workflows
# Stand-in generator: doc = the sorted workflow names; --check exits 1 when stale (the real contract).
cat > scripts/generate-workflow-dependencies.js <<'GEN'
const fs = require('fs'); const d = '.github/workflows';
const want = fs.readdirSync(d).filter((f) => f.endsWith('.yml')).sort().join(',') + '\n';
const p = d + '/DEPENDENCIES.md'; const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
if (process.argv.includes('--check')) process.exit(have === want ? 0 : 1);
fs.writeFileSync(p, want);
GEN
echo wf > .github/workflows/b.yml && echo 'old' > .github/workflows/DEPENDENCIES.md
git add . && git commit -qm "b2 adds a workflow"
run 0 ""
[ $RC -eq 0 ] && [ "$(cat .github/workflows/DEPENDENCIES.md)" = "b.yml" ] && [ -z "$(git status --porcelain)" ] \
  && [ "$(git log -1 --format=%s)" = "b2 adds a workflow" ] && [ "$(git rev-parse HEAD~2)" = "$BASE" ] \
  && grep -q 'regenerated it' <<<"$OUT" && ok "regenerated and amended, no extra commit" || bad "rc=$RC $OUT $(git log --oneline -3)"
echo "case 7: an up-to-date doc leaves HEAD as rebased"
before="$(git rev-parse HEAD)"; run 0 ""
[ $RC -eq 0 ] && [ "$(git rev-parse HEAD)" = "$before" ] && ! grep -q 'regenerated it' <<<"$OUT" && ok "untouched" || bad "rc=$RC $OUT"

[ $fail -eq 0 ] && echo "land-rebase test: OK" || { echo "land-rebase test: FAILED"; exit 1; }
