#!/usr/bin/env bash
# Forensic tool for task #466 — measure why push-with-retry.sh's post-conflict
# `git fetch` times out in CI.
#
# Usage: bash scripts/diagnose-shallow-fetch.sh [base_age_minutes]
#   env: DIAG_TOKEN   — token for cloning (defaults to $GITHUB_TOKEN)
#        DIAG_REPO    — owner/repo (defaults to $GITHUB_REPOSITORY, else origin)
#        DIAG_TIMEOUT — per-fetch hard cap in seconds (default 180)
#
# WHY THIS EXISTS
# ---------------
# Every workflow that pushes through scripts/lib/push-with-retry.sh runs on an
# actions/checkout with the DEFAULT `fetch-depth: 1` — i.e. a SHALLOW clone
# (~100 of the 129 callers; only 26 set fetch-depth: 0). When the push is
# rejected because main advanced, the script fetches the new tip. In a shallow
# repo a fetch that carries NO depth bound asks upload-pack for the ref's
# history with no cut-off, so the server sends the WHOLE repository (165k+
# commits, ~2.1 GB) instead of the ~500-object delta. That cannot finish inside
# GIT_NET_TIMEOUT_SEC, so every retry dies at the wall with rc=124 and the job
# fails 100% of the time once any conflict occurs.
#
# This script builds one identical depth-1 shallow clone per variant, pinned to
# a base commit `base_age_minutes` old (mirroring "checkout happened N minutes
# before the push"), and times each fetch form. It reports, per variant:
#   seconds, exit code, megabytes pulled into .git, and — critically — whether
#   ANCESTRY is restored. Ancestry is not optional: push-with-retry.sh rebases
#   and merges against origin/<branch>, so if the base commit is not an ancestor
#   of the fetched tip, the rebase replays the shallow root's whole-tree
#   snapshot instead of just our commit. A fast fetch that loses ancestry is a
#   WORSE bug than a slow one, which is why the table prints both columns.
set -uo pipefail

BASE_AGE_MIN="${1:-20}"
DIAG_TIMEOUT="${DIAG_TIMEOUT:-180}"
TOKEN="${DIAG_TOKEN:-${GITHUB_TOKEN:-}}"

REPO="${DIAG_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$REPO" ]; then
  REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
fi
[ -n "$REPO" ] || { echo "::error::cannot determine owner/repo"; exit 1; }

if [ -n "$TOKEN" ]; then
  URL="https://x-access-token:${TOKEN}@github.com/${REPO}.git"
else
  URL="https://github.com/${REPO}.git"
fi
REDACTED="https://github.com/${REPO}.git"

ROOT="${RUNNER_TEMP:-/tmp}/shallow-fetch-diag.$$"
rm -rf "$ROOT"; mkdir -p "$ROOT"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

# ── Pick a base commit ~BASE_AGE_MIN old ─────────────────────────────────────
# A depth-1 clone has no history to choose from, so ask the API. Falls back to
# the current remote tip (age 0) if the API is unavailable — the variants are
# still comparable, they just measure a smaller gap.
BASE_SHA=""
if command -v curl >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  since_iso=$(node -e "process.stdout.write(new Date(Date.now()-$BASE_AGE_MIN*60000).toISOString())")
  until_iso=$(node -e "process.stdout.write(new Date(Date.now()-$BASE_AGE_MIN*60000+120000).toISOString())")
  BASE_SHA=$(curl -sS ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      "https://api.github.com/repos/${REPO}/commits?sha=main&since=${since_iso}&until=${until_iso}&per_page=1" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(Array.isArray(j)&&j[0]?j[0].sha:"")}catch{process.stdout.write("")}})' \
      2>/dev/null || echo "")
fi
if [ -z "$BASE_SHA" ]; then
  BASE_SHA=$(git ls-remote "$URL" refs/heads/main | cut -f1)
  echo "note: API lookup failed — falling back to the current tip (gap will be ~0)"
fi

TIP_SHA=$(git ls-remote "$URL" refs/heads/main | cut -f1)
echo "repo=$REDACTED"
echo "base=$BASE_SHA (~${BASE_AGE_MIN}m old)   tip=$TIP_SHA"
[ "$BASE_SHA" = "$TIP_SHA" ] && echo "::warning::base == tip; there is nothing to fetch, so every variant will look fast"
echo

# ── Build one identical depth-1 shallow clone per variant ────────────────────
# Mirrors actions/checkout@v5 with fetch-depth: 1 (see the [command] lines in
# any job log): protocol v2, --no-tags --prune --depth=1 into the tracking ref.
mk() {
  local n="$1"
  git init -q "$ROOT/$n"
  git -C "$ROOT/$n" remote add origin "$URL"
  git -C "$ROOT/$n" -c protocol.version=2 fetch --no-tags --prune \
      --no-recurse-submodules --depth=1 origin "+$BASE_SHA:refs/remotes/origin/main" -q \
    || { echo "::error::setup fetch failed for variant $n"; return 1; }
  git -C "$ROOT/$n" update-ref refs/heads/main "$BASE_SHA"
  git -C "$ROOT/$n" symbolic-ref HEAD refs/heads/main
}

kb() { du -sk "$ROOT/$1/.git" 2>/dev/null | cut -f1; }

TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
run() {
  local n="$1" label="$2"; shift 2
  local before after t0 t1 rc anc
  before=$(kb "$n"); t0=$(date +%s)
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 5 "$DIAG_TIMEOUT" git -C "$ROOT/$n" fetch "$@" >/dev/null 2>&1; rc=$?
  else
    git -C "$ROOT/$n" fetch "$@" >/dev/null 2>&1; rc=$?
  fi
  t1=$(date +%s); after=$(kb "$n")
  if git -C "$ROOT/$n" merge-base --is-ancestor "$BASE_SHA" FETCH_HEAD 2>/dev/null; then anc=YES; else anc=NO; fi
  printf '%-40s %5ss  rc=%-4s %6s MB  ancestry=%s\n' \
    "$label" "$((t1 - t0))" "$rc" "$(((after - before) / 1024))" "$anc"
}

VARIANTS="v_bare v_explicit v_depth1 v_since"
for n in $VARIANTS; do mk "$n" || exit 1; done
echo "shallow=$(git -C "$ROOT/v_bare" rev-parse --is-shallow-repository)  local commits=$(git -C "$ROOT/v_bare" rev-list --count HEAD)"

BASE_EPOCH=$(git -C "$ROOT/v_bare" log -1 --format=%ct "$BASE_SHA")
SLACK=${SHALLOW_SINCE_SLACK_SEC:-1800}
echo "base epoch=$BASE_EPOCH  shallow-since slack=${SLACK}s"
echo
printf '%-40s %6s  %-7s %9s  %s\n' VARIANT TIME RC PULLED ANCESTRY

RS="+refs/heads/main:refs/remotes/origin/main"
# The two forms the incident report compared. Both omit a depth bound, so both
# request unbounded history from a shallow repo — the hypothesis under test is
# that they are equally slow, i.e. the refspec form is NOT the variable.
run v_bare     "bare (no depth) [today]"          origin main
run v_explicit "explicit-refspec (no depth) [today]" origin "$RS"
# Candidate fixes. --depth=1 is the fast-but-wrong control: it should show a
# short time AND ancestry=NO, proving why it cannot be the fix.
run v_depth1   "explicit + --depth=1 (control)"   --depth=1 origin "$RS"
run v_since    "explicit + --shallow-since (FIX)" --shallow-since="@$((BASE_EPOCH - SLACK))" origin "$RS"
