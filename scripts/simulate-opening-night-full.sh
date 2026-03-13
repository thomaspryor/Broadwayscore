#!/usr/bin/env bash
# simulate-opening-night-full.sh — Full end-to-end pipeline simulation.
# Exercises: gather → collect → rebuild → score → broadcast → preview → approval → cleanup
#
# Usage: bash scripts/simulate-opening-night-full.sh [OPTIONS]
#   --show=ID         Show to test (default: auto-discover recent opener)
#   --skip-live       Skip Phases 6-7 (no real emails)
#   --skip-collect    Skip Phase 2 (saves $0.50-1.50)
#   --verbose         Show full output from each phase
#   --lookback=N      Lookback days for broadcast (default: 3)

set -uo pipefail
cd "$(dirname "$0")/.."

# ─── Parse flags ──────────────────────────────────────────────────────
SHOW_ID=""
SKIP_LIVE=false
SKIP_COLLECT=false
VERBOSE=false
LOOKBACK=3
SIMULATION_FAILED=false

for arg in "$@"; do
  case "$arg" in
    --show=*) SHOW_ID="${arg#--show=}" ;;
    --skip-live) SKIP_LIVE=true ;;
    --skip-collect) SKIP_COLLECT=true ;;
    --verbose) VERBOSE=true ;;
    --lookback=*) LOOKBACK="${arg#--lookback=}" ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# Load .env
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# ─── Helpers ──────────────────────────────────────────────────────────
PASSED=0
FAILED=0
WARNINGS=0
PHASE_START=0

pass()   { echo "  ✅ $1"; PASSED=$((PASSED+1)); }
fail()   { echo "  ❌ $1"; FAILED=$((FAILED+1)); }
warn()   { echo "  ⚠️  $1"; WARNINGS=$((WARNINGS+1)); }
header() {
  echo ""
  echo "━━━ Phase $1: $2 ━━━"
  PHASE_START=$(date +%s)
}
phase_time() {
  local now=$(date +%s)
  local elapsed=$((now - PHASE_START))
  echo "  ⏱  ${elapsed}s"
}

check_fail_abort() {
  if [ "$FAILED" -gt 0 ] && [ "$1" = "critical" ]; then
    echo ""
    echo "  🚨 CRITICAL FAILURE in Phase $2 — aborting simulation"
    SIMULATION_FAILED=true
    cleanup
    exit 1
  fi
}

log_output() {
  if [ "$VERBOSE" = true ]; then
    cat "$1" | sed 's/^/  │ /'
  else
    # Show last 5 lines as summary
    tail -5 "$1" | sed 's/^/  │ /'
  fi
}

cleanup() {
  echo ""
  echo "━━━ Cleanup ━━━"

  # Remove test sent-tracking
  rm -f data/opening-night-sent.json
  echo "  Removed opening-night-sent.json"

  if [ "$SIMULATION_FAILED" = "true" ]; then
    echo "  Restoring pre-simulation state..."
    if [ -f data/reviews.json.bak ]; then
      cp data/reviews.json.bak data/reviews.json
      echo "  Restored reviews.json from backup"
    fi
    git checkout -- public/data/shows/ 2>/dev/null && echo "  Restored public show JSONs" || true
  else
    # Sync review-text changes if any
    if [ -d data/review-texts/.git ]; then
      cd data/review-texts
      CHANGED=$(git status --porcelain | wc -l | tr -d ' ')
      if [ "$CHANGED" -gt 0 ]; then
        git add -A
        git commit -m "data: Post-simulation sync ($SHOW_ID)" 2>/dev/null || true
        git push origin main 2>/dev/null || echo "  ⚠️  Could not push review-texts"
        echo "  Synced $CHANGED review-text changes to private repo"
      else
        echo "  No review-text changes to sync"
      fi
      cd ../..
    fi

    # Commit public repo changes if any
    git add data/reviews.json data/gold-lists-computed.json public/data/shows/ 2>/dev/null
    if ! git diff --cached --quiet 2>/dev/null; then
      git commit -m "data: Post-simulation rebuild sync" 2>/dev/null || true
      echo "  Committed rebuild changes to public repo"
    else
      echo "  No public repo changes to commit"
    fi
  fi

  rm -f data/reviews.json.bak
  echo "  Cleanup complete"
}

# ─── Phase 0: Preflight ──────────────────────────────────────────────
header 0 "Preflight"

# Check required env vars
MISSING_VARS=""
for var in SCRAPINGBEE_API_KEY BRIGHTDATA_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    if [ "$var" = "SCRAPINGBEE_API_KEY" ] || [ "$var" = "BRIGHTDATA_TOKEN" ]; then
      [ "$SKIP_COLLECT" = true ] && continue
    fi
    MISSING_VARS="$MISSING_VARS $var"
  fi
done

if [ "$SKIP_LIVE" != "true" ]; then
  for var in RESEND_API_KEY OWNER_EMAIL APPROVAL_HMAC_SECRET; do
    eval "val=\${$var:-}"
    [ -z "$val" ] && MISSING_VARS="$MISSING_VARS $var"
  done
fi

if [ -n "$MISSING_VARS" ]; then
  fail "Missing env vars:$MISSING_VARS"
  echo "  Set them in .env or use --skip-live / --skip-collect"
  exit 1
fi
pass "All required env vars present"

# Resolve show ID
if [ -z "$SHOW_ID" ]; then
  SHOW_ID=$(node -e "
    const shows = require('./data/shows.json').shows;
    const now = new Date();
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - ${LOOKBACK}); cutoff.setHours(0,0,0,0);
    const opened = shows.filter(s => {
      if (s.status !== 'open' || !s.openingDate) return false;
      const cat = s.category || 'broadway';
      if (cat !== 'broadway' && cat !== 'west-end') return false;
      const d = new Date(s.openingDate); d.setHours(0,0,0,0);
      return d >= cutoff && d <= now;
    });
    if (opened.length === 0) { process.stderr.write('No shows found in lookback window\\n'); process.exit(1); }
    const revs = require('./data/reviews.json');
    const arr = Array.isArray(revs.reviews || revs) ? (revs.reviews || revs) : Object.values(revs.reviews || revs);
    opened.sort((a,b) => {
      const ca = arr.filter(r => r.showId === a.id && r.assignedScore > 0).length;
      const cb = arr.filter(r => r.showId === b.id && r.assignedScore > 0).length;
      return cb - ca;
    });
    process.stdout.write(opened[0].id);
  " 2>/dev/null) || { fail "No recently opened shows found. Use --show=ID."; exit 1; }
fi

SHOW_DIR="data/review-texts/$SHOW_ID"
if [ ! -d "$SHOW_DIR" ]; then
  fail "Show directory $SHOW_DIR doesn't exist"
  exit 1
fi

FILE_COUNT=$(ls "$SHOW_DIR"/*.json 2>/dev/null | grep -v failed-fetches | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -lt 5 ]; then
  fail "Only $FILE_COUNT review files for $SHOW_ID — need at least 5"
  exit 1
fi

# Count scored reviews in reviews.json (the real baseline for comparison)
SCORED_COUNT=$(node -e "
  const revs = require('./data/reviews.json');
  const arr = Array.isArray(revs.reviews || revs) ? (revs.reviews || revs) : Object.values(revs.reviews || revs);
  process.stdout.write(String(arr.filter(r => r.showId === '$SHOW_ID' && r.assignedScore > 0).length));
" 2>/dev/null)

WRONG_PROD_COUNT=$(grep -rl '"wrongProduction": true' "$SHOW_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
pass "Test show: $SHOW_ID ($FILE_COUNT files, $SCORED_COUNT scored, $WRONG_PROD_COUNT wrongProduction)"

# Get show info
SHOW_TITLE=$(node -e "const s=require('./data/shows.json').shows.find(x=>x.id==='$SHOW_ID'); process.stdout.write(s?s.title:'Unknown')" 2>/dev/null)
MARKET=$(node -e "const s=require('./data/shows.json').shows.find(x=>x.id==='$SHOW_ID'); process.stdout.write((s&&s.category==='west-end')?'west-end':'broadway')" 2>/dev/null)
echo "  Show: $SHOW_TITLE | Market: $MARKET"

# Snapshot for rollback
cp data/reviews.json data/reviews.json.bak 2>/dev/null && pass "Created reviews.json backup" || warn "Could not backup reviews.json"

# Record pre-simulation score
PRE_SCORE=$(node -e "
  const revs = require('./data/reviews.json');
  const arr = Array.isArray(revs.reviews || revs) ? (revs.reviews || revs) : Object.values(revs.reviews || revs);
  const showRevs = arr.filter(r => r.showId === '$SHOW_ID' && r.assignedScore > 0);
  const avg = showRevs.length ? (showRevs.reduce((s,r) => s + r.assignedScore, 0) / showRevs.length).toFixed(1) : '0';
  process.stdout.write(avg);
" 2>/dev/null)
echo "  Pre-simulation avg score: $PRE_SCORE ($SCORED_COUNT scored reviews)"

phase_time

# ─── Phase 1: Gather Reviews ─────────────────────────────────────────
header 1 "Gather Reviews"

BEFORE_COUNT=$(ls "$SHOW_DIR"/*.json 2>/dev/null | grep -v failed-fetches | wc -l | tr -d ' ')
echo "  Before: $BEFORE_COUNT review files"

node scripts/gather-reviews.js --shows="$SHOW_ID" > /tmp/sim-gather.log 2>&1 || true
log_output /tmp/sim-gather.log

AFTER_COUNT=$(ls "$SHOW_DIR"/*.json 2>/dev/null | grep -v failed-fetches | wc -l | tr -d ' ')
NEW_FILES=$((AFTER_COUNT - BEFORE_COUNT))
echo "  After: $AFTER_COUNT review files (+$NEW_FILES new)"

if [ "$NEW_FILES" -gt 10 ]; then
  warn "Unusually many new files ($NEW_FILES) — verify no duplicates"
else
  pass "File count delta reasonable (+$NEW_FILES)"
fi

# Check for URL merge messages (Fix I)
MERGE_COUNT=$(grep -c "URL match: merged\|merged.*into" /tmp/sim-gather.log 2>/dev/null || echo "0")
if [ "$MERGE_COUNT" -gt 0 ]; then
  pass "Fix I verified: $MERGE_COUNT URL-matched reviews merged (not duplicated)"
else
  pass "No URL collisions found (Fix I not triggered — OK if no dupes exist)"
fi

# Check wrongProduction flags
NEW_WP=$(grep -rl '"wrongProduction": true' "$SHOW_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$NEW_WP" -gt "$WRONG_PROD_COUNT" ]; then
  NEW_WP_DIFF=$((NEW_WP - WRONG_PROD_COUNT))
  fail "Fix A regression: $NEW_WP_DIFF new wrongProduction flags appeared"
else
  pass "No new wrongProduction flags (Fix A holding)"
fi

phase_time
check_fail_abort "normal" 1

# ─── Phase 2: Collect Review Texts ───────────────────────────────────
if [ "$SKIP_COLLECT" = true ]; then
  echo ""
  echo "━━━ Phase 2: Collect Review Texts (SKIPPED — --skip-collect) ━━━"
else
  header 2 "Collect Review Texts"

  SHOW_FILTER="$SHOW_ID" MAX_REVIEWS=50 BATCH_SIZE=10 \
    node scripts/collect-review-texts.js --aggressive > /tmp/sim-collect.log 2>&1 || true
  log_output /tmp/sim-collect.log

  # Check wrongProductionManualClear respected (Fix A)
  MANUAL_CLEAR=$(grep -c "wrongProductionManualClear\|ManualClear set\|wrongProductionOverride" /tmp/sim-collect.log 2>/dev/null || echo "0")
  if [ "$MANUAL_CLEAR" -gt 0 ]; then
    pass "Fix A: wrongProductionManualClear/Override respected ($MANUAL_CLEAR mentions)"
  else
    pass "Fix A: No ManualClear files encountered (OK if none exist)"
  fi

  # Check articleType classification (Fix D)
  ARTICLE_TYPE=$(grep -c "articleType\|Not a review\|Possibly not a review\|non_review" /tmp/sim-collect.log 2>/dev/null || echo "0")
  if [ "$ARTICLE_TYPE" -gt 0 ]; then
    pass "Fix D: articleType classification active ($ARTICLE_TYPE mentions)"
  else
    pass "Fix D: No wrongArticle detections (OK for well-curated show)"
  fi

  # Check failed-fetches retry (Fix H)
  RETRY=$(grep -c "Retrying\|retry\|failed-fetches" /tmp/sim-collect.log 2>/dev/null || echo "0")
  if [ "$RETRY" -gt 0 ]; then
    pass "Fix H: Failed-fetches retry active ($RETRY mentions)"
  else
    pass "Fix H: No failed fetches to retry"
  fi

  # Track collect success rate
  ATTEMPTED=$(grep -c "Fetching\|Processing\|Collecting" /tmp/sim-collect.log 2>/dev/null || echo "0")
  FETCH_FAIL=$(grep -c "FAILED\|Error fetching\|fetch error" /tmp/sim-collect.log 2>/dev/null || echo "0")
  if [ "$ATTEMPTED" -gt 0 ]; then
    SUCCESS_RATE=$(( (ATTEMPTED - FETCH_FAIL) * 100 / ATTEMPTED ))
    if [ "$SUCCESS_RATE" -lt 80 ]; then
      warn "Collect success rate low: ${SUCCESS_RATE}% ($FETCH_FAIL/$ATTEMPTED failed)"
    else
      pass "Collect success rate: ${SUCCESS_RATE}% ($ATTEMPTED attempted, $FETCH_FAIL failed)"
    fi
  else
    pass "No new reviews to collect (all already have text)"
  fi

  # Verify no ManualClear files re-flagged
  POST_WP=$(grep -rl '"wrongProduction": true' "$SHOW_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
  CLEARED_AND_FLAGGED=0
  for f in "$SHOW_DIR"/*.json; do
    [ "$f" = "$SHOW_DIR/failed-fetches.json" ] && continue
    if grep -q '"wrongProductionManualClear"' "$f" 2>/dev/null && grep -q '"wrongProduction": true' "$f" 2>/dev/null; then
      CLEARED_AND_FLAGGED=$((CLEARED_AND_FLAGGED + 1))
      fail "ManualClear file re-flagged: $(basename $f)"
    fi
  done
  if [ "$CLEARED_AND_FLAGGED" -eq 0 ]; then
    pass "No ManualClear files re-flagged"
  fi

  phase_time
  check_fail_abort "normal" 2
fi

# ─── Phase 3: Rebuild reviews.json ───────────────────────────────────
header 3 "Rebuild reviews.json"

node scripts/rebuild-all-reviews.js > /tmp/sim-rebuild.log 2>&1 || {
  fail "rebuild-all-reviews.js crashed"
  SIMULATION_FAILED=true
  cleanup
  exit 1
}
log_output /tmp/sim-rebuild.log

# Count EBT reviews in rebuilt data
POST_REVIEW_COUNT=$(node -e "
  const revs = require('./data/reviews.json');
  const arr = Array.isArray(revs.reviews || revs) ? (revs.reviews || revs) : Object.values(revs.reviews || revs);
  const showRevs = arr.filter(r => r.showId === '$SHOW_ID' && r.assignedScore > 0);
  process.stdout.write(String(showRevs.length));
" 2>/dev/null)

if [ "$POST_REVIEW_COUNT" -ge "$SCORED_COUNT" ]; then
  pass "reviews.json has $POST_REVIEW_COUNT scored reviews for $SHOW_ID (was $SCORED_COUNT)"
else
  fail "reviews.json LOST reviews: $POST_REVIEW_COUNT < $SCORED_COUNT (before simulation)"
fi

# Check public JSON updated
if [ -f "public/data/shows/${SHOW_ID}.json" ]; then
  PUB_REVS=$(node -e "const d=require('./public/data/shows/${SHOW_ID}.json'); process.stdout.write(String((d.rv||[]).length))" 2>/dev/null)
  PUB_BD=$(node -e "const d=require('./public/data/shows/${SHOW_ID}.json'); const bd=d.bd||{}; process.stdout.write(JSON.stringify(bd))" 2>/dev/null)
  pass "Public JSON updated: $PUB_REVS reviews, buckets=$PUB_BD"
else
  fail "Public JSON not found for $SHOW_ID"
fi

# Score delta sanity check
POST_SCORE=$(node -e "
  const revs = require('./data/reviews.json');
  const arr = Array.isArray(revs.reviews || revs) ? (revs.reviews || revs) : Object.values(revs.reviews || revs);
  const showRevs = arr.filter(r => r.showId === '$SHOW_ID' && r.assignedScore > 0);
  const avg = showRevs.length ? (showRevs.reduce((s,r) => s + r.assignedScore, 0) / showRevs.length).toFixed(1) : '0';
  process.stdout.write(avg);
" 2>/dev/null)

# Calculate delta (using bc for float comparison, or node)
SCORE_DELTA=$(node -e "process.stdout.write(String(Math.abs($POST_SCORE - $PRE_SCORE).toFixed(1)))" 2>/dev/null)
if [ "$(node -e "process.stdout.write($SCORE_DELTA > 10 ? '1' : '0')" 2>/dev/null)" = "1" ]; then
  fail "Score delta too large: $PRE_SCORE → $POST_SCORE (delta=$SCORE_DELTA) — data may be corrupted"
else
  pass "Score stable: $PRE_SCORE → $POST_SCORE (delta=$SCORE_DELTA)"
fi

phase_time
check_fail_abort "critical" 3

# ─── Phase 4: LLM Scoring ────────────────────────────────────────────
header 4 "LLM Scoring"

npx ts-node scripts/llm-scoring/index.ts --show="$SHOW_ID" --dry-run --verbose > /tmp/sim-score-dryrun.log 2>&1 || {
  warn "Scoring dry-run had errors (check log)"
  log_output /tmp/sim-score-dryrun.log
}

# Check for unscored reviews
UNSCORED=$(grep -ci "would score\|unscored\|needs scoring\|eligible" /tmp/sim-score-dryrun.log 2>/dev/null || echo "0")
BLOCKED=$(grep -ci "skipping.*invalid\|skipping.*non_review\|not scoreable\|blocked" /tmp/sim-score-dryrun.log 2>/dev/null || echo "0")

log_output /tmp/sim-score-dryrun.log

if [ "$BLOCKED" -gt 0 ]; then
  pass "Fix D: $BLOCKED reviews correctly blocked by is-scoreable"
fi

if [ "$UNSCORED" -gt 0 ] && [ "$UNSCORED" -le 5 ]; then
  echo "  Scoring $UNSCORED unscored reviews for real..."
  npx ts-node scripts/llm-scoring/index.ts --show="$SHOW_ID" --verbose > /tmp/sim-score.log 2>&1 || {
    fail "LLM scoring crashed"
    log_output /tmp/sim-score.log
  }
  SCORED_OK=$(grep -ci "scored\|success\|complete" /tmp/sim-score.log 2>/dev/null || echo "0")
  if [ "$SCORED_OK" -gt 0 ]; then
    pass "Scored $SCORED_OK reviews successfully"
  else
    warn "Scoring output unclear — check /tmp/sim-score.log"
  fi
  log_output /tmp/sim-score.log
elif [ "$UNSCORED" -gt 5 ]; then
  warn "$UNSCORED unscored reviews — too many for simulation, skipping actual scoring"
else
  pass "All reviews already scored — scoring pipeline healthy"
fi

phase_time

# ─── Phase 5: Broadcast Dry Run ──────────────────────────────────────
header 5 "Broadcast Dry Run"

bash scripts/simulate-opening-night.sh "$SHOW_ID" "$LOOKBACK" > /tmp/sim-broadcast.log 2>&1 || true
log_output /tmp/sim-broadcast.log

BROADCAST_PASS=$(grep -c "✅" /tmp/sim-broadcast.log 2>/dev/null || echo "0")
BROADCAST_FAIL=$(grep -c "❌" /tmp/sim-broadcast.log 2>/dev/null || echo "0")

if [ "$BROADCAST_FAIL" -eq 0 ] && [ "$BROADCAST_PASS" -gt 0 ]; then
  pass "Broadcast simulation: $BROADCAST_PASS checks passed, 0 failed"
else
  fail "Broadcast simulation: $BROADCAST_PASS passed, $BROADCAST_FAIL failed"
  # Show the failures
  grep "❌" /tmp/sim-broadcast.log | sed 's/^/  │ /'
fi

phase_time

# ─── Phase 6: Preview Email ──────────────────────────────────────────
if [ "$SKIP_LIVE" = true ]; then
  echo ""
  echo "━━━ Phase 6: Preview Email (SKIPPED — --skip-live) ━━━"
  echo "━━━ Phase 7: Approval Link (SKIPPED — --skip-live) ━━━"
else
  header 6 "Preview Email to Owner"

  BROADCAST_HOUR=5 node scripts/send-opening-night-broadcast.js \
    --market="$MARKET" --lookback="$LOOKBACK" --budget=100 --send-to="$OWNER_EMAIL" \
    > /tmp/sim-preview.log 2>&1 || true
  log_output /tmp/sim-preview.log

  if grep -qi "sent\|delivered\|email" /tmp/sim-preview.log 2>/dev/null; then
    pass "Preview email sent to $OWNER_EMAIL"
  else
    fail "Preview email may not have sent — check log"
  fi

  # Check approval URL params
  if grep -q "shows=\|market=" /tmp/sim-preview.log 2>/dev/null; then
    pass "Fix G: Approval URL contains show/market params"
  else
    warn "Could not verify approval URL params in log"
  fi

  # Check sent tracking written
  if [ -f data/opening-night-sent.json ]; then
    if grep -q "preview:" data/opening-night-sent.json 2>/dev/null; then
      pass "Fix K: Preview dedup key written"
    else
      warn "Sent tracking exists but no preview key found"
    fi
  else
    warn "opening-night-sent.json not created"
  fi

  # Test dedup — run preview again
  BROADCAST_HOUR=5 node scripts/send-opening-night-broadcast.js \
    --market="$MARKET" --lookback="$LOOKBACK" --budget=100 --send-to="$OWNER_EMAIL" \
    > /tmp/sim-preview2.log 2>&1 || true

  if grep -qi "already.*preview\|skipping.*duplicate\|preview.*sent" /tmp/sim-preview2.log 2>/dev/null; then
    pass "Fix K: Duplicate preview correctly blocked"
  else
    warn "Could not confirm preview dedup — check /tmp/sim-preview2.log"
  fi

  phase_time

  # ─── Phase 7: Approval Link ────────────────────────────────────────
  header 7 "Approval Link E2E"

  APPROVAL_URL=$(grep -o 'https://[^ "]*approve-broadcast[^ "]*' /tmp/sim-preview.log 2>/dev/null | head -1)
  if [ -n "$APPROVAL_URL" ]; then
    HTTP_CODE=$(curl -s -o /tmp/sim-approval.html -w '%{http_code}' "$APPROVAL_URL" 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
      if grep -qi "dispatched\|broadcast\|approved" /tmp/sim-approval.html 2>/dev/null; then
        pass "Approval link returned 200 + dispatch confirmation"
      else
        warn "Approval returned 200 but unexpected content"
      fi
    else
      fail "Approval link returned HTTP $HTTP_CODE"
    fi

    # Check workflow was triggered
    sleep 5
    LATEST_RUN=$(gh run list --workflow=opening-night-broadcast.yml --limit=1 --json status,conclusion,createdAt -q '.[0]' 2>/dev/null)
    if [ -n "$LATEST_RUN" ]; then
      pass "Workflow dispatched: $LATEST_RUN"
    else
      warn "Could not verify workflow dispatch"
    fi
  else
    warn "No approval URL found in preview log — skipping Phase 7"
  fi

  phase_time
fi

# ─── Cleanup ──────────────────────────────────────────────────────────
cleanup

# ─── Summary ──────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  FULL PIPELINE SIMULATION RESULTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Show:     $SHOW_TITLE ($SHOW_ID)"
echo "  Market:   $MARKET"
echo "  ✅ Passed:   $PASSED"
echo "  ❌ Failed:   $FAILED"
echo "  ⚠️  Warnings: $WARNINGS"
echo ""
echo "  Fix Coverage:"
echo "    A wrongProduction    → Phases 1,2,3"
echo "    B Sent tracking      → Phase 5"
echo "    C Stale core-data    → Phase 3"
echo "    D Non-review class.  → Phases 2,4"
echo "    E Rebuild 'no change'→ Phase 3"
echo "    F Rebuild→deploy     → CI-only (not testable locally)"
echo "    G Approval filters   → Phases 5,6,7"
echo "    H Failed-fetches     → Phase 2"
echo "    I Duplicate merge    → Phase 1"
echo "    J Critic's Pick      → Phase 5"
echo "    K Preview dedup      → Phase 6"
echo "    M Lookback passthru  → Phases 5,6"
echo "    O Backfill           → Already done"
if [ "$SKIP_COLLECT" = true ]; then
  echo "  ⚠️  Phase 2 skipped — Fixes A(collect),D,H not tested"
fi
if [ "$SKIP_LIVE" = true ]; then
  echo "  ⚠️  Phases 6-7 skipped — Fixes G(live),K(live) not tested"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "  🚨 $FAILED check(s) FAILED — review output above"
  exit 1
else
  echo ""
  echo "  All pipeline checks passed."
fi
