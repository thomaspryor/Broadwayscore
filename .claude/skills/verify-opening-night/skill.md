---
name: verify-opening-night
version: "1.2.0"
description: "TRIGGER when: user asks 'is everything ready for opening night', user says 'check opening night readiness', session is an opening-night session for a Broadway or West End show. Runs the full 9-point readiness checklist (CLAUDE.md rule 14) and reports PASS/FAIL per check. Takes show_id as argument (e.g. /verify-opening-night giant-2026)."
argument-hint: "<show_id> [--market=broadway|westend] [--post-opening]"
allowed-tools: Bash, Read
user-invocable: true
---

# Opening Night Readiness Checker

Run every check below in order. For each: execute the command, evaluate the output, and print `✅ PASS` or `❌ FAIL — <reason>` on the same line as the check name.

At the end, print a summary: total checks, pass count, fail count. If any check FAIL, print the exact fix command.

## Setup

```bash
SHOW_ID="${SKILL_ARGS:-$1}"
# If no arg, ask which show
```

If `$SHOW_ID` is empty, ask the user which show they want to check before running any checks.

Determine market from shows.json:
```bash
node -e "
const data = require('./data/shows.json');
const shows = data.shows || data;
const s = shows.find(x => x.id === '$SHOW_ID');
if (!s) { console.log('NOT_FOUND'); process.exit(1); }
console.log(JSON.stringify({ title: s.title, market: s.market || 'broadway', openingDate: s.openingDate, status: s.status }));
"
```

---

## Check 1: Orchestrator Cron Has Fired

**Purpose:** Confirm the 3 AM UTC Broadway cron (or 10 PM UTC West End) has actually fired before — not just scheduled.

```bash
gh run list --workflow=opening-night-orchestrator.yml --limit 10 \
  --json createdAt,conclusion \
  --jq '.[] | .createdAt' | head -5
```

PASS if: at least 1 run listed.
FAIL if: empty — the cron has never fired. Fix: `gh workflow run opening-night-orchestrator.yml -f show_id=$SHOW_ID -f market=broadway`

---

## Check 2: Orchestrator in CRITICAL_CRONS Health List

**Purpose:** Ensure the orchestrator is monitored so failures page.

```bash
grep -c "opening-night-orchestrator" .github/workflows/check-cron-health.yml
```

PASS if: count ≥ 1.
FAIL if: 0. Fix: add `opening-night-orchestrator.yml` to CRITICAL_CRONS in `check-cron-health.yml`.

---

## Check 3: ScrapingBee Credits

**Purpose:** Needs >25% remaining. Opening nights burn 100-300 credits.

```bash
gh workflow run check-secrets-health.yml
sleep 30
gh run list --workflow=check-secrets-health.yml --limit 1 --json databaseId --jq '.[0].databaseId' | xargs -I{} gh run view {} --log | grep -i "scrapingbee\|SB credits\|credit" | tail -5
```

PASS if: output shows <75% used (i.e., >25% remaining).
FAIL if: ≥75% used or run not found. Fix: check SB dashboard and budget; add `SB_CREDIT_BUDGET=1000` to the opening-night-poller workflow env for tonight.

---

## Check 4: Wrong-Production Pre-Scores

**Purpose:** Ensure any pre-existing LLM score files are from the CURRENT production, not a prior run.

```bash
ls data/llm-scores/$SHOW_ID/ 2>/dev/null && \
node -e "
const fs = require('fs');
const dir = 'data/llm-scores/$SHOW_ID';
if (!fs.existsSync(dir)) { console.log('No pre-scores — OK'); process.exit(0); }
const files = fs.readdirSync(dir);
files.forEach(f => {
  const data = JSON.parse(fs.readFileSync(dir+'/'+f));
  if (data.wrongProduction) console.log('WRONG_PROD: ' + f);
  else console.log('OK: ' + f);
});
"
```

PASS if: no files, or all files lack `wrongProduction: true`.
FAIL if: any file has `wrongProduction: true`. Fix: those files are from a prior run — set `wrongProduction: true` in each flagged source file.

---

## Check 5: DTLI Slug (Broadway only)

**Purpose:** DTLI slug maps to the CURRENT season page, not an old production. Only run AFTER opening night reviews have landed (page doesn't exist pre-opening).

```bash
node -e "
const m = require('./data/dtli-slug-map.json');
const slug = m.shows && m.shows['$SHOW_ID'];
console.log('DTLI slug:', slug || 'MISSING');
"
```

PASS if: slug exists and looks correct for the current production (e.g., `giant-2` not `giant` for a revival).
SKIP (pre-opening): If show hasn't opened yet, this is expected to be missing — the page doesn't exist pre-opening. Mark as `⏭ SKIP (pre-opening)`.
FAIL (post-opening): slug is missing or points to old production. Fix: add slug to `data/dtli-slug-map.json`.

---

## Check 6: Bright Data Zone

**Purpose:** Zone must not be disabled. Check via API (or secrets-health workflow covers this).

```bash
curl -s "https://api.brightdata.com/zone?zone=${BRIGHTDATA_ZONE:-web_unlocker2}" \
  -H "Authorization: Bearer $BRIGHTDATA_TOKEN" | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log('disable field:', d?.plan?.disable ?? 'absent (zone active)');
"
```

PASS if: `disable` field is absent or null.
FAIL if: `disable` field has a value. Fix: Bright Data UI only — Recover + enable toggle in Configuration tab (API cannot re-enable). Create a new zone if recovery fails.

---

## Check 7: BWW Review Roundup URL (Broadway, post-opening)

**Purpose:** BWW only publishes the Review Roundup AFTER reviews start dropping. Pre-opening = skip.

Check opening date vs today to determine whether to run:
```bash
node -e "
const data = require('./data/shows.json');
const shows = data.shows || data;
const s = shows.find(x => x.id === '$SHOW_ID');
const opened = s?.openingDate && new Date(s.openingDate) <= new Date();
console.log(opened ? 'POST_OPENING' : 'PRE_OPENING');
"
```

If PRE_OPENING: Mark as `⏭ SKIP (pre-opening — BWW RR doesn't exist yet)`.

If POST_OPENING: Attempt to find the BWW Review Roundup URL:
```bash
# Pattern: https://www.broadwayworld.com/article/Review-Roundup-{TITLE-SLUG}-Opens-on-Broadway-{YYYYMMDD}
# Search for it:
node -e "
const data = require('./data/shows.json');
const shows = data.shows || data;
const s = shows.find(x => x.id === '$SHOW_ID');
console.log('Show:', s?.title, '| Opening:', s?.openingDate);
console.log('Expected BWW RR pattern: Review-Roundup-[title-slug]-Opens-on-Broadway-[YYYYMMDD]');
"
```

PASS if: BWW RR URL is already in the show's aggregator sources in reviews.json.
FAIL if: post-opening and no BWW RR found. Fix: search BWW manually and pass URL to opening-night-poller via `--bww-roundup-url`.

---

## Check 8: Talkin' Broadway URL (Broadway, post-opening)

**Purpose:** TB is T2 outlet — don't miss it. Only post-opening. TB doesn't cover West End.

If PRE_OPENING or WEST_END: Mark as `⏭ SKIP`.

If POST_OPENING Broadway: Check if TB review is in reviews.json (note: reviews.json is in the private data repo and may not be available locally — if not found, check data/review-texts/$SHOW_ID/ for a talkinbroadway file instead):
```bash
node -e "
try {
  const data = require('./data/reviews.json');
  const reviews = Array.isArray(data) ? data : (data.reviews || []);
  const showReviews = reviews.filter(r => r.showId === '$SHOW_ID');
  const tb = showReviews.find(r => r.outletId === 'talkinbroadway' || (r.url || '').includes('talkinbroadway.com'));
  console.log(tb ? 'FOUND: ' + tb.url : 'NOT_FOUND');
} catch(e) {
  // reviews.json not local — check review-texts folder instead
  const fs = require('fs');
  const dir = 'data/review-texts/$SHOW_ID';
  if (!fs.existsSync(dir)) { console.log('NOT_FOUND (no review-texts dir)'); process.exit(0); }
  const files = fs.readdirSync(dir);
  const tb = files.find(f => f.includes('talkinbroadway'));
  console.log(tb ? 'FOUND in review-texts: ' + tb : 'NOT_FOUND in review-texts');
}
"
```

PASS if: TB review found.
FAIL if: post-opening and no TB review. Fix: URL pattern is `https://www.talkinbroadway.com/page/world/{titleslug}{year}.html`. SERP returns forum posts (All That Chat) instead — use direct URL.

---

## Check 9: Orchestrator Ran Successfully in Last 24h

**Purpose:** Confirm the orchestrator ran successfully recently (it processes all active shows per run — show IDs don't appear in run titles).

```bash
gh run list --workflow=opening-night-orchestrator.yml --limit 20 \
  --json createdAt,conclusion \
  --jq '.[] | select(.conclusion == "success") | .createdAt' | head -5
```

Then check if the most recent success is within 24 hours of now.

PASS if: a successful run exists within the last 24 hours.
WARN if: most recent success is >24h ago but <48h (may just be timing).
FAIL if: no successful run in last 48 hours. Fix: `gh workflow run opening-night-orchestrator.yml -f show_id=$SHOW_ID -f market=broadway`

---

## Check 10: Pipeline Stage Drift

**Purpose:** Confirm all 4 pipeline stages agree on the review count for this show (review-texts → reviews.json → public/data/shows/*.json → live CDN). Catches the silent-drop class documented in the 2026-04-15 incident.

```bash
node scripts/check-opening-night-drift.js --show=$SHOW_ID --format=table
```

Output format: `Show  Opening  Local  Agg  LocalJSON  Live  Drift  Status`.

PASS if: `Drift` column is 0 (all 4 stages agree) AND `Status` is `ok`.
GRACE (accept): `Status` is `grace` — stage 3↔4 drift within the 15-min Vercel deploy-lag window. Re-run in 5 min to confirm it clears.
FAIL if: `Drift` > 0 with status `watch` or `ALERT`. Fix: `node scripts/verify-review-recovery.js --show=$SHOW_ID --production` to isolate which stage is stale.

---

## Check 11: Mobile Shows JSON Currency

**Purpose:** Confirm `public/data/mobile-shows.json` reflects the current show status and review count. This file is what the iOS app reads — it can go stale while the web side updates correctly, leaving the app blind to new reviews after opening.

```bash
node -e "
const fs = require('fs');
const mobileFile = 'public/data/mobile-shows.json';
if (!fs.existsSync(mobileFile)) { console.log('NOT_FOUND'); process.exit(0); }
const data = JSON.parse(fs.readFileSync(mobileFile));
const shows = Array.isArray(data) ? data : (data.shows || []);
const s = shows.find(x => x.id === '$SHOW_ID');
if (!s) { console.log('SHOW_MISSING_FROM_MOBILE'); process.exit(0); }
console.log('status:', s.status, '| reviewCount:', s.reviewCount ?? s.reviews?.length ?? 'unknown');
"
```

PASS if: show exists in mobile-shows.json AND `status` matches expected (e.g. `open` post-opening) AND reviewCount > 0 post-opening.
SKIP (pre-opening): if show hasn't opened yet, reviewCount of 0 is expected — mark `⏭ SKIP (pre-opening)`.
FAIL (post-opening): show is missing, status is still `upcoming`, or reviewCount is 0. Fix: `node scripts/generate-mobile-data.js && git add public/data/mobile-shows.json && git commit -m "chore: refresh mobile-shows.json for $SHOW_ID"`

---

## Summary Output Format

```
Opening Night Readiness: [SHOW TITLE] ([SHOW_ID])
Market: Broadway | Opening: [DATE]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Check 1: Orchestrator cron has fired
✅ Check 2: Orchestrator in CRITICAL_CRONS
✅ Check 3: ScrapingBee credits (48% used — OK)
⏭  Check 4: Wrong-prod pre-scores (no pre-scores)
✅ Check 5: DTLI slug (giant-2)
❌ Check 6: Bright Data zone DISABLED
⏭  Check 7: BWW Review Roundup (pre-opening)
⏭  Check 8: Talkin' Broadway (pre-opening)
✅ Check 9: Orchestrator run for show
✅ Check 10: Pipeline stage drift (0)
⏭  Check 11: Mobile shows JSON (pre-opening)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Result: 6 PASS, 1 FAIL, 4 SKIP

⚠️  FIX REQUIRED:
Check 6: Bright Data zone disabled. Go to Bright Data UI → Configuration tab → Recover → enable toggle.
```

Do not end until all checks are complete and the summary is printed.
