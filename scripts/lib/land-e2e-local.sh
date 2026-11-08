#!/usr/bin/env bash
# land-e2e-local.sh (BRO-7106) — browser E2E against a LOCAL build of the
# current tree, for land.yml's advisory `e2e-local` job.
#
# WHY
#   test.yml's E2E job runs Playwright against PRODUCTION after a change has
#   landed and deployed, so a src/ change that breaks a user flow is caught
#   only once it is live (tests/e2e/user-flows.spec.ts:115, BRO-7106). This
#   runs the same specs against `next start` on the tree being landed.
#
# WHY NOT A GATE IN land-gauntlet.sh
#   /second-opinion review: the gauntlet is the checks job's serial critical
#   path (55-min budget, ~35 min already on a cold land), is shared with
#   land-local-check and the codex runner, and `npm run build` rewrites tracked
#   files (scripts/prebuild.sh) while the gauntlet's background lane runs in
#   the same tree. So this is its own job, in parallel, writing results in the
#   gauntlet's result-dir shape so scripts/lib/land-gate-delta.js
#   (--gates e2e-local) judges branch-vs-base the same way.
#
# USAGE
#   bash scripts/lib/land-e2e-local.sh <outdir>
#   Writes <outdir>/e2e-local.{exit,log}, <outdir>/e2e-local.json (Playwright
#   JSON report) and <outdir>/meta.json. Always exits 0 itself; the verdict is
#   e2e-local.exit (read by land-gate-delta.js), like land-gauntlet.sh.
#
# ENV
#   E2E_LOCAL_SPECS     space-separated spec paths (default: smoke-first set
#                       below; widen once the runtime is measured, BRO-7106)
#   E2E_LOCAL_PORT      port for next start (default 3457)
#   E2E_LOCAL_TIMEOUT   seconds for build + tests (default 1200)
#   E2E_LOCAL_FEATURES  NEXT_PUBLIC_FEATURES for the build
#   CI                  set: a missing Playwright/browser is a failure, not a skip
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)  # staged copy may live outside the tree (base run)
OUT="${1:?usage: land-e2e-local.sh <outdir>}"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

SPECS="${E2E_LOCAL_SPECS:-tests/e2e/smoke.spec.ts tests/e2e/user-flows.spec.ts}"
PORT="${E2E_LOCAL_PORT:-3457}"
LIMIT="${E2E_LOCAL_TIMEOUT:-1200}"
FEATURES="${E2E_LOCAL_FEATURES:-criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions}"
START_MS=$(node -e 'console.log(Date.now())')

write_meta() {
  node -e '
    const fs = require("fs");
    const [out, sha, root, start] = process.argv.slice(1);
    fs.writeFileSync(out + "/meta.json", JSON.stringify({ sha, root, wallMs: Date.now() - Number(start), gates: ["e2e-local"] }, null, 2) + "\n");
  ' "$OUT" "$(git rev-parse HEAD)" "$ROOT" "$START_MS"
}

finish() { # finish <rc>
  echo "$1" > "$OUT/e2e-local.exit"
  write_meta
  echo "gate e2e-local: exit $1 ($(( ($(node -e 'console.log(Date.now())') - START_MS) / 1000 ))s)"
  exit 0
}

# Restore tracked files the build regenerates (scripts/prebuild.sh), so a
# later checkout of the base tree is not refused and the tree is left as found.
# Only after a build this script started (marker), and the build only starts
# on a clean tree (run() below), so this never discards someone's edits.
restore_tree() { [ -f "$OUT/.built" ] && { git checkout -- . 2>/dev/null || true; rm -f "$OUT/.built"; }; return 0; }

run() {
  # Missing tooling: off CI it is a skip (local runs, no browser); on CI it is
  # a red result, never a silent pass (second-opinion review).
  if [ ! -d node_modules/@playwright/test ] || ! npx --no-install playwright --version >/dev/null 2>&1; then
    if [ -n "${CI:-}" ]; then echo "::error::e2e-local gate failed: @playwright/test not installed (exit 1)"; return 1; fi
    echo "# SKIP e2e-local: @playwright/test not installed here; CI runs"; return 0
  fi
  local missing=""
  for s in $SPECS; do [ -f "$s" ] || missing="$missing $s"; done
  [ -z "$missing" ] || echo "::warning::e2e-local: spec(s) not on this tree, skipped:$missing"
  local present=""
  for s in $SPECS; do [ -f "$s" ] && present="$present $s"; done
  if [ -z "$present" ]; then echo "e2e-local: none of the specs exist on this tree"; return 0; fi

  # The build rewrites tracked files and the cleanup restores them with
  # `git checkout -- .`, so refuse a dirty tree rather than lose edits.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    if [ -n "${CI:-}" ]; then echo "::error::e2e-local gate failed: tracked files modified before the build (exit 1)"; return 1; fi
    echo "# SKIP e2e-local: uncommitted tracked changes; commit first (the build rewrites tracked files)"; return 0
  fi
  : > "$OUT/.built"
  echo "::group::e2e-local build"
  NEXT_PUBLIC_FEATURES="$FEATURES" SKIP_HEAVY_PREBUILD=true \
    NEXT_PUBLIC_SANITY_PROJECT_ID="${NEXT_PUBLIC_SANITY_PROJECT_ID:-fp1ft8k8}" \
    NEXT_PUBLIC_SANITY_DATASET="${NEXT_PUBLIC_SANITY_DATASET:-production}" \
    npm run build
  local brc=$?
  echo "::endgroup::"
  if [ "$brc" -ne 0 ]; then echo "::error::e2e-local gate failed: next build (exit $brc)"; return 1; fi

  npx next start -p "$PORT" > "$OUT/next-start.log" 2>&1 &
  local srv=$!
  echo "$srv" > "$OUT/next-start.pid"
  # shellcheck disable=SC2064
  trap "kill $srv 2>/dev/null; wait $srv 2>/dev/null" RETURN
  local up=0
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "http://localhost:$PORT/"; then up=1; break; fi
    kill -0 "$srv" 2>/dev/null || break
    sleep 1
  done
  if [ "$up" -ne 1 ]; then
    tail -20 "$OUT/next-start.log"
    echo "::error::e2e-local gate failed: next start did not serve :$PORT (exit 1)"; return 1
  fi

  # shellcheck disable=SC2086
  PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/e2e-local.json" PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/e2e-local.json" \
    TEST_BASE_URL="http://localhost:$PORT" \
    npx playwright test $present --project=chromium --reporter=list,json
  local prc=$?
  # One ::error:: line per test whose final outcome is unexpected (a retry
  # pass is "flaky" = pass). land-gate-delta.js keys on these lines.
  node "$HERE/land-e2e-local-report.js" "$OUT/e2e-local.json" || true
  return "$prc"
}

export -f run
export SPECS PORT FEATURES OUT ROOT HERE
timeout --kill-after=30 "$LIMIT" bash -c run 2>&1 | tee "$OUT/e2e-local.log"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 124 ] && echo "::error::e2e-local gate failed: timed out after ${LIMIT}s (exit 124)" | tee -a "$OUT/e2e-local.log"
# A timeout kills `bash -c run` but not the server it started.
if [ -f "$OUT/next-start.pid" ]; then kill "$(cat "$OUT/next-start.pid")" 2>/dev/null || true; rm -f "$OUT/next-start.pid"; fi
restore_tree
finish "$rc"
