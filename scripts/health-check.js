#!/usr/bin/env node
/**
 * Daily Data Health Check
 *
 * Monitors all automated pipelines for silent failures.
 * Checks across 9 categories:
 *   A. Data Freshness (7) — are data files up to date?
 *   B. Data Sync (4) — do derived files match source files?
 *   C. Pipeline Health (6) — did critical workflows run recently? (warn only)
 *   D. Content Quality (1) — is scored review percentage healthy?
 *   E. Cookie Expiration (1) — are paywall cookies still valid?
 *   F. Core Web Vitals (1) — Lighthouse performance regressions
 *   G. SEO Health (1) — index coverage and traffic anomalies
 *   H. Cron Health (6) — are critical scheduled workflows running?
 *   I. Secrets Health (1) — last check-secrets-health run status
 *   J. API Credits (1) — ScrapingBee credit balance
 *
 * Progressive alerting:
 *   - Digest snapshot: always (data/audit/health-digest-snapshot.json — card #364,
 *     folded into the autonomous loop's single scheduled morning email instead
 *     of sending its own "BSC Daily"/"BSC URGENT" email via Resend)
 *   - #weekly-reports: always (Discord daily summary)
 *   - #alerts: only after 2+ consecutive error days
 *
 * Triage state: writes per-system files to data/audit/triage/ for auto-triage pipeline.
 * Auto-triage issue: creates GitHub issue with 'auto-triage' label for persistent errors.
 *
 * Exit codes: 0 = pass/warn or first-day errors, 1 = persistent errors (2+ days)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { getTodayJsonlPath } = require('./lib/exclusion-logger');
const { computeCommercialModelDriftStatus } = require('./lib/commercial-model-drift');
const { routeAlert, readDispatchAttempts, peekDigestQueue, clearDigestQueue } = require('./lib/owner-alert-router.js');
const { readOwnerEmailLog } = require('./lib/discord-notify.js');
const { SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION, isScrapingBeeExhaustionAcknowledged } = require('./lib/scrapingbee-ack');
const { evaluateScrapingdogCredits } = require('./lib/scrapingdog-ack');
const { cachedShell, cachedFetch, hasLowHeadroom } = require('./lib/gh-api-cache.js');
const { assessAutofixEffectiveness } = require('./lib/autofix-effectiveness');
const { isBroadwayCategory } = require('./lib/venue-classification');
// Discord daily reports removed — email digest is the single notification channel.

// Generate a signed one-tap approve URL for a fix workflow.
// Returns '' if ALERT_TOKEN_SECRET is not set.
function generateApproveUrl(workflowFile, alertTitle) {
  const secret = process.env.ALERT_TOKEN_SECRET;
  if (!secret || !workflowFile) return '';
  const payload = { fixId: workflowFile, alertTitle, expiry: Date.now() + 86400000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return `https://broadwayscorecard.com/api/dispatch-alert-fix?token=${encodeURIComponent(`${encoded}.${sig}`)}`;
}
// Critical workflow failures still alert via notify-failure composite action.

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const PIPELINE_DIR = path.join(AUDIT_DIR, 'pipeline-health');
const TRIAGE_DIR = path.join(AUDIT_DIR, 'triage');
const HISTORY_FILE = path.join(AUDIT_DIR, 'health-check-history.json');
// Card #364 (owner merge decision 2026-07-26): health-check.js no longer emails
// its own "BSC Daily"/"BSC URGENT" digest. It writes results here instead;
// autonomous-email.js reads this snapshot and folds it into the single
// scheduled morning email — one email/day, not two.
const HEALTH_DIGEST_SNAPSHOT_FILE = path.join(AUDIT_DIR, 'health-digest-snapshot.json');

// --- Auto-Fix Playbook ---
// Maps health check names (regex) to automated fixes or human-readable instructions.
// `workflow`: dispatched automatically via `gh workflow run` (user sees "Auto-fixed").
// `humanAction`: plain-English instruction for non-technical user (no jargon).
// `urgency`: 'fix-now' (red), 'this-week' (yellow), 'low' (gray).

const AUTO_FIX_PLAYBOOK = [
  // Card #1199. A check with NO playbook entry defaults to urgency 'low'
  // (~L3271), which drops it out of `actionable` entirely: it never reaches
  // routeAlert, and renders as an anonymous "+N low-priority items monitoring
  // themselves (no action needed)" line — no name, no rate, no hint. For a
  // check whose entire purpose is to end a chronic failure's invisibility,
  // that would have shipped the measurement invisible, which is the exact
  // defect the card exists to close (caught by the ship-check reviewer).
  // 'this-week', not 'fix-now': the retry layer recovers the WORK, so a high
  // dead rate is expensive and worth chasing but never data loss.
  { match: /^Dispatch health: dead-launch rate$/, urgency: 'this-week',
    humanAction: 'More than 1 in 10 cmux dispatches is creating its workspace but never rendering a terminal surface, so the seeded command never runs. The retry layer recovers the work, so nothing is lost — but each failure burns a launch and leaves a zombie tab. Run `node scripts/audit-dispatch-dead-rate.js` for the per-day/per-lane breakdown, then open Claude Code and say: "Investigate the dispatch dead-launch rate (card #1199) — judge any fix by this rate over a week, never by one clean dispatch."' },
  // Freshness — all auto-fixable via workflow dispatch
  { match: /^Freshness: reviews\.json$/, urgency: 'fix-now', workflow: 'rebuild-reviews.yml',
    humanFallback: 'The review scores database is out of date. This usually fixes itself overnight.' },
  { match: /^Freshness: shows\.json$/, urgency: 'fix-now', workflow: 'update-show-status.yml',
    humanFallback: 'The show database is out of date. This usually fixes itself overnight.' },
  { match: /^Freshness: grosses\.json$/, urgency: 'this-week', workflow: 'weekly-grosses.yml',
    humanFallback: 'Box office data is out of date. Updated weekly — may just be a slow week.' },
  { match: /^Freshness: audience-buzz\.json$/, urgency: 'this-week', workflow: 'update-show-score.yml',
    humanFallback: 'Audience scores are out of date.' },
  { match: /^Audience coverage: open-show gaps$/, urgency: 'this-week',
    humanAction: 'A currently-running show has audience ratings on a source that never linked — usually a title/venue mismatch. The check message names the source(s) and the correct override knob (MEZZANINE_OVERRIDES in scrape-mezzanine-audience.js, or THEATR_OVERRIDES in scrape-theatr-audience.js — they are separate). Open Claude Code and say: "Add the override for the flagged show and re-run that source’s scraper." Details in data/audit/mezzanine-coverage.json / theatr-coverage.json.' },
  { match: /^Freshness: commercial\.json$/, urgency: 'low', workflow: 'commercial-weekly.yml',
    humanFallback: 'Commercial data is out of date.' },
  { match: /^Freshness: critic-consensus\.json$/, urgency: 'low', workflow: 'update-critic-consensus.yml',
    humanFallback: 'Critic consensus summaries are out of date.' },
  { match: /^Freshness: lottery-rush\.json$/, urgency: 'fix-now', workflow: 'update-lottery-rush.yml',
    humanFallback: 'Lottery/rush data is out of date. Workflow runs hourly — stale >48h means it is failing silently, or running without producing output.' },
  { match: /^Freshness: cast-changes\.json$/, urgency: 'this-week', workflow: 'update-cast-changes.yml',
    humanFallback: 'Cast change tracking is out of date. Runs Wednesday and Saturday — stale >5 days means the workflow is failing.' },
  { match: /^Freshness: nyt-critics-picks\.json$/, urgency: 'this-week', workflow: 'weekly-nyt-critics-picks.yml',
    humanFallback: 'NYT Critics Picks list is out of date. Runs Mon/Wed/Fri — stale >3 days means the workflow is failing.' },
  { match: /^Freshness: video-reviews\.json$/, urgency: 'this-week', workflow: 'weekly-video-reviews.yml',
    humanFallback: 'Video reviews data is out of date. Runs Mondays — stale >2 weeks means the workflow is failing.' },
  { match: /^Freshness: social-pulse\/_meta\.json$/, urgency: 'this-week', workflow: 'update-social-pulse.yml',
    humanFallback: 'Social Scorecard data is out of date. Runs Mondays — powers /trending pages. Stale >2 weeks means the workflow is failing.' },
  // No `workflow` — there's no automated fix, this just needs a human to look
  // at the scoring workflow's polling. 'this-week' (not fix-now): a batch
  // between 12-48h in flight is within the vendor's normal turnaround, not an
  // emergency by itself — only worth paging once it recurs (see task #547).
  { match: /^Scoring: batch state$/, urgency: 'this-week',
    humanFallback: 'The nightly review-scoring batch is taking longer than expected to come back from the AI vendor. It usually resolves on its own within a day — this needs attention if it keeps recurring.' },

  // Sync — some auto-fixable
  { match: /^Sync: review-texts vs reviews\.json$/, urgency: 'fix-now', workflow: 'rebuild-reviews.yml',
    humanFallback: 'Review database is out of sync with source files.' },
  { match: /^Sync: cast coverage$/, urgency: 'this-week',
    humanAction: 'One or more open Broadway shows are missing cast data. Open Claude Code and say: "Run backfill-cast.js to repopulate cast data for open shows."' },
  { match: /^Sync: open show coverage$/, urgency: 'this-week',
    humanAction: 'Some open shows are missing reviews or grosses data. Open Claude Code and say: "Check which open shows are missing data and collect reviews for them."' },
  { match: /^Sync: baseline drift$/, urgency: 'this-week',
    humanAction: 'The data counts have drifted from the last known-good baseline. Open Claude Code and say: "Run validate-data.js and update the validation baseline."' },

  // Pipeline — warn-only, no auto-fix needed (they run on schedule)
  { match: /^Pipeline:/, urgency: 'low',
    humanAction: "A scheduled pipeline hasn't run recently. It may just be delayed — check again tomorrow." },

  // Quality — needs investigation
  { match: /^Quality: standingCoverage drift$/, urgency: 'this-week',
    humanAction: 'Some critic outlets should be added to or removed from the "reviews every Broadway opening" list, based on their actual coverage. Open Claude Code and say: "Check the standingCoverage drift and update outlet-registry.json."' },
  { match: /^Quality: coverageExpectation drift$/, urgency: 'this-week',
    humanAction: 'An outlet\'s "does not review theatre" flag is stale or contradicted by actual coverage. Open Claude Code and say: "Check the coverageExpectation drift and re-decide the flagged outlets."' },
  { match: /^Quality: outlet-heartbeat red flags$/, urgency: 'this-week',
    humanAction: 'One or more critic outlets have gone quiet for 2+ straight weekly checks. Open Claude Code and say: "Check the outlet-heartbeat red flags and find out if the outlet stopped reviewing or an extractor broke."' },

  // Silent-exclusion detectors (#1147 tracker, card #1188, ship-check
  // finding). Without explicit entries these fall through to the generic
  // /^Quality:/ route below and get described as a scored-review-percentage
  // problem, which is not what either measures — same trap the SERP census
  // recall entry above exists to avoid.
  { match: /^Quality: missing contentTier$/, urgency: 'this-week',
    humanAction: 'A review-text file has fullText + a real byline + no rejection flags but no contentTier, so it is not reaching reviews.json. Open Claude Code and say: "Check the missing contentTier gap named in this check and restore contentTier on that review-text file."' },
  { match: /^Quality: outlet domain moves$/, urgency: 'this-week',
    humanAction: 'An unregistered host name-matches a known outlet — probably that outlet moved to a new domain (e.g. a critic switching to Substack) and reviews on the new host are being silently dropped. Open Claude Code and say: "Check the probable outlet domain move named in this check, confirm it, and add the host to that outlet\'s domainAliases."' },
  { match: /^Quality: outlet stub rate$/, urgency: 'this-week',
    humanAction: 'An outlet has a spike in stub-tier (0-char extraction) reviews collected in the last 30 days — the signature of a site redesign breaking its article-extractor.js pattern (this is exactly what happened with TheaterMania in 2026). Open Claude Code and say: "Check the outlet stub-rate flag named in this check, confirm the extractor is broken, and fix the article-extractor.js pattern for that outlet."' },

  { match: /^Quality:/, urgency: 'this-week',
    humanAction: 'The percentage of scored reviews has dropped. Open Claude Code and say: "Check why the scored review percentage dropped and fix it."' },

  // Coverage Verdict S1 (#872/#898). Without an explicit entry this would fall
  // through to the generic route and be described as a scored-review-percentage
  // problem, which is not what it measures.
  { match: /^Coverage: SERP census recall$/, urgency: 'this-week',
    humanAction: 'The review census is finding fewer published reviews than it recently did, so new shows may be going live with reviews missing. Open Claude Code and say: "Check the census recall regression — run audit-serp-census-recall.js and find which arm dropped."' },

  // Affiliate revenue monitor (affiliate hardening 2026-08-03). fix-now: this
  // is the site's only revenue stream, and check-affiliate-health.js already
  // filtered out Poisson noise before writing anything non-pass.
  { match: /^Revenue: affiliate health$/, urgency: 'fix-now',
    humanAction: 'The affiliate ticket-revenue monitor flagged a problem (or the monitor itself stopped running). Open Claude Code and say: "Run check-affiliate-health.js --dry-run and investigate the failing layer — the check output names it (site clicks, Impact handoff, conversions, or payouts)."' },

  // Cookies — requires human action on Mac. Urgency escalates with proximity.
  { match: /^Cookies:/, urgency: 'fix-now',
    humanAction: 'A paywall cookie needs refreshing. On your Mac, open Claude Code and say: "Refresh the expired paywall cookies — check which ones need updating."',
    useCountdown: true },

  // CWV — needs investigation
  { match: /^CWV:/, urgency: 'this-week',
    humanAction: 'Website performance has degraded. Open Claude Code and say: "Check the Core Web Vitals report and fix any performance regressions."' },

  // SEO — needs investigation
  { match: /^SEO:/, urgency: 'this-week',
    humanAction: 'SEO health has degraded. Open Claude Code and say: "Check the SEO health report and fix any issues."' },

  // Cron staleness — low-priority; auto-dispatch for a few known-fixable ones.
  // NB: failed-last-run cases are emitted under `Cron failed:` (see below)
  // so they route to fix-now instead of being buried here.
  { match: /^Cron: Rebuild Reviews$/, urgency: 'low', workflow: 'rebuild-reviews.yml',
    humanFallback: 'The review rebuild pipeline may be stalled.' },
  { match: /^Cron: Update Show Status$/, urgency: 'low', workflow: 'update-show-status.yml',
    humanFallback: 'Show status updates may be stalled.' },
  { match: /^Cron: Collect Review Texts$/, urgency: 'low', workflow: 'collect-review-texts.yml',
    humanFallback: 'Review text collection may be stalled.' },
  { match: /^Cron:/, urgency: 'low',
    humanAction: "A scheduled job hasn't run recently. It'll likely run on its next schedule. If it persists, open Claude Code and say: \"Check why the cron jobs aren't running.\"" },

  // Cron failed-last-run — surfaces in the daily digest's prominent section.
  // Added 2026-04-14 so that update-lottery-rush / weekly-grosses / etc.
  // failures don't sit silently in the Actions log for a week.
  { match: /^Cron failed:/, urgency: 'fix-now',
    humanAction: 'A critical scheduled workflow failed its most recent run. Open Claude Code and say: "Check what broke in {workflow} and fix it."' },

  // Repeat workflow failures — promoted from a passive digest body section to a
  // first-class check (2026-06-16, Notion 381637c5) so a workflow failing 2+
  // times in 24h escalates (subject line, error count, auto-triage) instead of
  // sitting silently. The check name carries the workflow, e.g.
  // "Workflow repeat-failure: update-lottery-rush.yml". Self-resolves once the
  // workflow stops failing.
  { match: /^Workflow repeat-failure:/, urgency: 'fix-now',
    humanAction: 'A workflow failed repeatedly in the last 24 hours — likely broken, not a transient blip. Open Claude Code and say: "Check what broke in this workflow and fix it." The Repeat Workflow Failures section below links each failing run.' },

  // Secrets — needs manual rotation
  { match: /^Secrets:/, urgency: 'fix-now',
    humanAction: 'A secret or API key may be expiring. On your Mac, open Claude Code and say: "Check which secrets need rotation and rotate them."' },

  // API Credits — needs attention if low. Provider-specific entries first;
  // the generic /^Credits:/ line is the fallback for future providers
  // (ship-check 2026-07-26: the SB copy used to render for ScrapingDog too).
  { match: /^Credits: ScrapingDog/, urgency: 'this-week',
    humanAction: 'ScrapingDog credits are running low. Check usage at app.scrapingdog.com and consider upgrading or reducing scraping frequency.' },
  { match: /^Credits:/, urgency: 'this-week',
    humanAction: 'ScrapingBee credits are running low. Check usage at app.scrapingbee.com and consider upgrading or reducing scraping frequency.' },
];

function getPlaybookEntry(checkName) {
  for (const entry of AUTO_FIX_PLAYBOOK) {
    if (entry.match.test(checkName)) return entry;
  }
  return null;
}

// Attempt auto-fix by dispatching a GitHub Actions workflow.
// Returns { fixed: true/false, message: string }
async function tryAutoFix(checkResult) {
  const entry = getPlaybookEntry(checkResult.name);
  if (!entry || !entry.workflow) return { fixed: false };

  // Guard: max 2 auto-fix attempts per check per day (resets at midnight UTC)
  const checkSlug = checkResult.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const triageFile = path.join(TRIAGE_DIR, `autofix-${checkSlug}.json`);
  try {
    if (fs.existsSync(triageFile)) {
      const triage = readJSON(triageFile);
      const lastFixDate = triage.lastAutoFix ? new Date(triage.lastAutoFix).toISOString().slice(0, 10) : null;
      const todayDate = new Date().toISOString().slice(0, 10);
      const attemptsToday = lastFixDate === todayDate ? (triage.autoFixAttempts || 0) : 0;
      if (attemptsToday >= 2) {
        console.log(`[Auto-Fix] Skipping ${checkResult.name} — already attempted ${attemptsToday} times today`);
        return { fixed: false, message: 'Max auto-fix attempts reached for today' };
      }
    }
  } catch {}

  // Dispatch the workflow
  try {
    execSync(
      `gh workflow run "${entry.workflow}"`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log(`[Auto-Fix] Dispatched ${entry.workflow} for ${checkResult.name}`);

    // Increment auto-fix attempt counter (per-check, resets daily)
    try {
      let triage = {};
      if (fs.existsSync(triageFile)) triage = readJSON(triageFile);
      const lastFixDate = triage.lastAutoFix ? new Date(triage.lastAutoFix).toISOString().slice(0, 10) : null;
      const todayDate = new Date().toISOString().slice(0, 10);
      triage.autoFixAttempts = (lastFixDate === todayDate ? (triage.autoFixAttempts || 0) : 0) + 1;
      triage.lastAutoFix = new Date().toISOString();
      triage.lastAutoFixWorkflow = entry.workflow;
      fs.mkdirSync(path.dirname(triageFile), { recursive: true });
      fs.writeFileSync(triageFile, JSON.stringify(triage, null, 2) + '\n');
    } catch {}

    return { fixed: true, workflow: entry.workflow };
  } catch (err) {
    console.error(`[Auto-Fix] Failed to dispatch ${entry.workflow}: ${err.message.substring(0, 100)}`);
    return { fixed: false, message: `Dispatch failed: ${err.message.substring(0, 80)}` };
  }
}

// --- Helpers ---

function hoursAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function formatAge(hours) {
  if (hours === Infinity) return 'unknown';
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runCheck(name, fn) {
  try {
    return fn();
  } catch (err) {
    return { name, status: 'error', message: `Check crashed: ${err.message}` };
  }
}

// --- Category A: Data Freshness ---

const FRESHNESS_CHECKS = [
  { file: 'reviews.json', field: '_meta.lastUpdated', warnH: 48, errorH: 96, hint: 'Check rebuild-reviews workflow in Actions tab' },
  { file: 'shows.json', field: '_meta.lastUpdated', warnH: 24, errorH: 36, hint: 'Check update-show-status workflow in Actions tab' },
  { file: 'grosses.json', field: 'lastUpdated', warnH: 240, errorH: 336, hint: 'Check weekly-grosses workflow in Actions tab' },
  { file: 'audience-buzz.json', field: '_meta.lastUpdated', warnH: 240, errorH: 336, hint: 'Check audience buzz workflows in Actions tab' },
  { file: 'commercial.json', field: '_meta.lastUpdated', warnH: 336, errorH: 504, hint: 'Check commercial-weekly workflow in Actions tab' },
  { file: 'critic-consensus.json', field: '_meta.lastGenerated', warnH: 336, errorH: 504, hint: 'Check update-critic-consensus workflow in Actions tab' },
  { file: 'lottery-rush.json', field: 'lastUpdated', warnH: 48, errorH: 72, hint: 'Check update-lottery-rush workflow in Actions tab' },
  { file: 'cast-changes.json', field: 'lastUpdated', warnH: 72, errorH: 120, hint: 'Check update-cast-changes workflow in Actions tab (runs Wed+Sat)' },
  { file: 'nyt-critics-picks.json', field: '_meta.lastUpdated', warnH: 72, errorH: 120, hint: 'Check nyt-critics-picks workflow in Actions tab (runs Mon/Wed/Fri)' },
  { file: 'video-reviews.json', field: '_meta.generatedAt', warnH: 192, errorH: 336, hint: 'Check weekly-video-reviews workflow in Actions tab (runs Monday)' },
  { file: 'social-pulse/_meta.json', field: 'lastUpdated', warnH: 192, errorH: 336, hint: 'Check update-social-pulse workflow in Actions tab (runs Monday); powers /trending' },
  // Tony odds — only relevant April–June. Large thresholds so stale off-season files don't false-alarm.
  { file: 'tony-win-probabilities.json', field: '_meta.lastUpdated', warnH: 36, errorH: 72, hint: 'Check update-tony-awards workflow — GoldDerby scraper may have failed', seasonMonths: [4, 5, 6] },
  { file: 'tony-polymarket-odds.json', field: '_meta.lastUpdated', warnH: 36, errorH: 72, hint: 'Check update-tony-awards workflow — Polymarket scraper may have failed or returned 0 categories', seasonMonths: [4, 5, 6] },
  { file: 'tony-kalshi-odds.json', field: '_meta.lastUpdated', warnH: 36, errorH: 72, hint: 'Check update-tony-awards workflow — Kalshi scraper may have failed or returned 0 categories', seasonMonths: [4, 5, 6] },
];

function checkFreshness() {
  const currentMonth = new Date().getMonth() + 1; // 1-12
  return FRESHNESS_CHECKS.map(({ file, field, warnH, errorH, hint, seasonMonths }) =>
    runCheck(`Freshness: ${file}`, () => {
      if (seasonMonths && !seasonMonths.includes(currentMonth)) {
        return { name: `Freshness: ${file}`, status: 'ok', message: 'Skipped (off-season)' };
      }
      const filePath = path.join(DATA_DIR, file);
      if (!fs.existsSync(filePath)) {
        return { name: `Freshness: ${file}`, status: 'error', message: `File missing`, hint };
      }
      const data = readJSON(filePath);
      // Navigate nested field like "_meta.lastUpdated"
      const value = field.split('.').reduce((obj, key) => obj && obj[key], data);
      if (!value) {
        return { name: `Freshness: ${file}`, status: 'error', message: `No ${field} field`, hint };
      }
      const age = hoursAgo(value);
      if (age === Infinity) {
        return { name: `Freshness: ${file}`, status: 'error', message: `Unparseable date: ${value}`, hint };
      }
      if (age > errorH) {
        return { name: `Freshness: ${file}`, status: 'error', message: `${formatAge(age)} old (error threshold: ${formatAge(errorH)})`, hint };
      }
      if (age > warnH) {
        return { name: `Freshness: ${file}`, status: 'warn', message: `${formatAge(age)} old (warn threshold: ${formatAge(warnH)})`, hint };
      }
      return { name: `Freshness: ${file}`, status: 'pass', message: `${formatAge(age)} old` };
    })
  );
}

// --- Category A2: Push Verification ---
// Detects silent push failures: workflow succeeds but data never reaches private repo.
// Compares _meta.lastUpdated against last successful workflow run time.

const PUSH_VERIFY_CHECKS = [
  { file: 'shows.json', field: '_meta.lastUpdated', workflow: 'update-show-status.yml', name: 'Update Show Status', maxDriftH: 6 },
];

function checkPushVerification() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Push verify: shows.json', status: 'warn', message: 'Skipped — no GH_TOKEN' }];
  }

  return PUSH_VERIFY_CHECKS.map(({ file, field, workflow, name, maxDriftH }) =>
    runCheck(`Push verify: ${file}`, () => {
      try {
        // Get last successful workflow run time. Cached: 15 CRITICAL_CRONS
        // entries + this check all share ONE shared PAT/rate-limit budget
        // across every concurrently-dispatched session on this Mac — see
        // scripts/lib/gh-api-cache.js header for why.
        const result = cachedShell(
          `push-verify:${workflow}`,
          `gh run list --workflow="${workflow}" --status=success --limit=1 --json createdAt -q '.[0].createdAt'`
        );
        if (!result) {
          return { name: `Push verify: ${file}`, status: 'warn', message: `No successful ${name} runs found` };
        }
        const workflowTime = new Date(result);

        // Get data timestamp from file
        const filePath = path.join(DATA_DIR, file);
        if (!fs.existsSync(filePath)) {
          return { name: `Push verify: ${file}`, status: 'warn', message: 'File missing' };
        }
        const data = readJSON(filePath);
        const value = field.split('.').reduce((obj, key) => obj && obj[key], data);
        if (!value) {
          return { name: `Push verify: ${file}`, status: 'warn', message: `No ${field} field` };
        }
        const dataTime = new Date(value);

        // If workflow ran successfully but data timestamp is older by more than maxDriftH,
        // the push likely failed silently
        const driftH = (workflowTime.getTime() - dataTime.getTime()) / (1000 * 60 * 60);
        if (driftH > maxDriftH) {
          return {
            name: `Push verify: ${file}`,
            status: 'error',
            message: `Data ${formatAge(hoursAgo(value))} old but ${name} succeeded ${formatAge(hoursAgo(result))} ago — push may have failed`,
            hint: `Check ${workflow} logs for "No core data changes" or push errors`,
          };
        }
        return { name: `Push verify: ${file}`, status: 'pass', message: `Data synced (${formatAge(hoursAgo(value))} old, workflow ${formatAge(hoursAgo(result))} ago)` };
      } catch (err) {
        return { name: `Push verify: ${file}`, status: 'warn', message: `Check failed: ${err.message.substring(0, 80)}` };
      }
    })
  );
}

// --- Category A2b: Opening Night History Push Verification ---
// Same drift logic as checkPushVerification() above (workflow ran
// successfully more recently than the data reflects => the write/push is
// failing silently even though the workflow itself reports green) — but
// data/audit/opening-night-history.json stores its freshness signal as the
// newest entry in a `runs[]` array, not a `_meta.lastUpdated`-style field, so
// it can't be expressed as another PUSH_VERIFY_CHECKS entry (that generic
// field-path reducer doesn't index arrays). Task #1073: this exact failure
// mode ran undetected for 100+ days — opening-night-checklist.yml stayed
// green ~5x/day while its history append silently crashed on every run from
// 2026-04-26 onward (see the diagnosis comment above appendToHistory() in
// scripts/opening-night-checklist.js). 26h (not the generic 24h) gives the
// hourly cron slack for one missed/late tick before alerting.
const OPENING_NIGHT_HISTORY_MAX_DRIFT_H = 26;

function checkOpeningNightHistoryFreshness() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Push verify: opening-night-history.json', status: 'warn', message: 'Skipped — no GH_TOKEN' }];
  }
  return [runCheck('Push verify: opening-night-history.json', () => {
    try {
      // Get last successful workflow run time (same gh invocation shape and
      // shared cache as checkPushVerification() above).
      const result = cachedShell(
        'push-verify:opening-night-checklist.yml',
        `gh run list --workflow="opening-night-checklist.yml" --status=success --limit=1 --json createdAt -q '.[0].createdAt'`
      );
      if (!result) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'No successful Opening Night Checklist runs found' };
      }
      const workflowTime = new Date(result);

      const filePath = path.join(AUDIT_DIR, 'opening-night-history.json');
      if (!fs.existsSync(filePath)) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'File missing' };
      }
      const data = readJSON(filePath);
      const runs = Array.isArray(data.runs) ? data.runs : [];
      if (runs.length === 0) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'No runs[] entries in file' };
      }
      const newest = runs[runs.length - 1];
      if (!newest || !newest.at) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'Newest runs[] entry has no `at` field' };
      }
      const dataTime = new Date(newest.at);
      if (isNaN(dataTime.getTime())) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: `Unparseable date on newest runs[] entry: ${newest.at}` };
      }

      // If the workflow ran successfully but the newest history entry is
      // older by more than OPENING_NIGHT_HISTORY_MAX_DRIFT_H, the append is
      // likely failing silently on every run (workflow green, ledger frozen).
      const driftH = (workflowTime.getTime() - dataTime.getTime()) / (1000 * 60 * 60);
      if (driftH > OPENING_NIGHT_HISTORY_MAX_DRIFT_H) {
        return {
          name: 'Push verify: opening-night-history.json',
          status: 'error',
          message: `Newest history entry ${formatAge(hoursAgo(newest.at))} old but Opening Night Checklist succeeded ${formatAge(hoursAgo(result))} ago — history append may be failing silently`,
          hint: 'Check the "Run opening night checklist" step\'s logged exit code in opening-night-checklist.yml (0/1 expected; anything else — including exit 3 — means appendToHistory() failed). See the diagnosis comment above appendToHistory() in scripts/opening-night-checklist.js.',
        };
      }
      return { name: 'Push verify: opening-night-history.json', status: 'pass', message: `History synced (newest entry ${formatAge(hoursAgo(newest.at))} old, workflow ${formatAge(hoursAgo(result))} ago)` };
    } catch (err) {
      return { name: 'Push verify: opening-night-history.json', status: 'warn', message: `Check failed: ${err.message.substring(0, 80)}` };
    }
  })];
}

// --- Category B: Data Sync ---

function checkSync() {
  const results = [];

  // B1: review-texts count vs reviews.json count
  results.push(runCheck('Sync: review-texts vs reviews.json', () => {
    const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
    let fileCount = 0;
    if (fs.existsSync(reviewTextsDir)) {
      const showDirs = fs.readdirSync(reviewTextsDir).filter(d =>
        fs.statSync(path.join(reviewTextsDir, d)).isDirectory()
      );
      for (const dir of showDirs) {
        const files = fs.readdirSync(path.join(reviewTextsDir, dir))
          .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
        fileCount += files.length;
      }
    }
    // review-texts live in a private repo — if not checked out, skip this check
    if (fileCount === 0) {
      return { name: 'Sync: review-texts vs reviews.json', status: 'pass', message: 'Skipped — review-texts not checked out (private repo)' };
    }
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));
    const reviewCount = reviews._meta?.stats?.totalReviews || 0;
    // Deficit = reviews.json has MORE entries than source files (phantom reviews)
    const deficit = reviewCount - fileCount;
    if (deficit > 50) {
      return { name: 'Sync: review-texts vs reviews.json', status: 'error', message: `reviews.json has ${deficit} more entries than source files`, hint: 'Run rebuild-reviews workflow to resync' };
    }
    if (deficit > 10) {
      return { name: 'Sync: review-texts vs reviews.json', status: 'warn', message: `reviews.json has ${deficit} more entries than source files` };
    }
    return { name: 'Sync: review-texts vs reviews.json', status: 'pass', message: `${fileCount} files, ${reviewCount} reviews (surplus: ${fileCount - reviewCount})` };
  }));

  // B2: Open show coverage (reviews + grosses)
  results.push(runCheck('Sync: open show coverage', () => {
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));
    const grosses = readJSON(path.join(DATA_DIR, 'grosses.json'));

    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    // Only check Broadway shows — WE/OB are expected to have gaps
    const openShows = showList.filter(s => s.status === 'open' && isBroadwayCategory(s));

    // Build review lookup by showId from flat reviews array
    const reviewedShowIds = new Set();
    const reviewsList = reviews.reviews || [];
    for (const r of reviewsList) {
      if (r.showId) reviewedShowIds.add(r.showId);
    }

    const grossesSlugs = new Set(Object.keys(grosses.shows || {}));

    let missingReviews = 0;
    let missingGrosses = 0;
    const missingReviewsList = [];
    const missingGrossesList = [];

    for (const show of openShows) {
      if (!reviewedShowIds.has(show.id)) {
        missingReviews++;
        if (missingReviewsList.length < 5) missingReviewsList.push(show.title);
      }
      if (!grossesSlugs.has(show.slug)) {
        missingGrosses++;
        if (missingGrossesList.length < 5) missingGrossesList.push(show.title);
      }
    }

    const parts = [];
    let worstStatus = 'pass';

    if (missingReviews > 5) {
      worstStatus = 'error';
      parts.push(`${missingReviews} open shows missing reviews (${missingReviewsList.join(', ')})`);
    } else if (missingReviews > 3) {
      worstStatus = 'warn';
      parts.push(`${missingReviews} open shows missing reviews`);
    }

    if (missingGrosses > 5) {
      if (worstStatus !== 'error') worstStatus = 'warn';
      parts.push(`${missingGrosses} open shows missing grosses`);
    }

    if (parts.length === 0) {
      return { name: 'Sync: open show coverage', status: 'pass', message: `${openShows.length} open shows all have reviews and grosses` };
    }
    return { name: 'Sync: open show coverage', status: worstStatus, message: parts.join('; '), hint: 'Check gather-reviews and weekly-grosses workflows' };
  }));

  // Audience source coverage gaps — promotes the per-source coverage audits
  // (mezzanine-coverage.json / theatr-coverage.json) from a passive digest
  // section into a CHECK, narrowed to CURRENTLY OPEN shows. Each audit flags
  // an unmatched high-volume source-catalog entry that fuzzy-matches one of our
  // shows lacking that source — data the source has but our matcher didn't link
  // (title-drift / missing override). The 2026-06-22 Encores La Cage miss (85
  // Mezzanine ratings never linked, an "Encores!" prefix + venue-ambiguity gap)
  // WAS flagged in mezzanine-coverage.json but sat unseen among ~36 closed-
  // revival flags in the passive section. Filtering to open shows + making it a
  // check means a running show missing a source now drives the subject line.
  results.push(runCheck('Audience coverage: open-show gaps', () => {
    const { openShowCoverageGaps } = require('./lib/audience-coverage-gaps');
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const openIds = new Set(showList.filter(s => s.status === 'open').map(s => s.id));

    const reports = [];
    const unreadable = [];
    for (const [source, file] of [['Mezzanine', 'mezzanine-coverage.json'], ['Theatr', 'theatr-coverage.json']]) {
      const p = path.join(DATA_DIR, 'audit', file);
      if (!fs.existsSync(p)) continue;
      try {
        const audit = JSON.parse(fs.readFileSync(p, 'utf8'));
        reports.push({ source, flagged: audit.flagged || [] });
      } catch (_) {
        // An audit file that EXISTS but won't parse is a broken input, not a
        // clean bill of health — track it so we don't report 'ok' on a file we
        // couldn't actually read (that would silently re-hide the La Cage class).
        unreadable.push(file);
      }
    }

    const gaps = openShowCoverageGaps(reports, openIds);
    if (gaps.length === 0) {
      if (unreadable.length > 0) {
        return { name: 'Audience coverage: open-show gaps', status: 'warn', message: `Could not read coverage audit: ${unreadable.join(', ')} — gap detection blind for ${unreadable.length} source(s)`, hint: 'The scraper wrote a malformed audit file. Re-run the scraper to regenerate it.' };
      }
      return { name: 'Audience coverage: open-show gaps', status: 'ok', message: 'No open shows with unlinked audience sources' };
    }
    const top = gaps.slice(0, 5)
      .map(g => `${g.source}: ${g.ourTitle} (${g.ratingsCount} ratings ↔ ${g.sourceName || '?'})`)
      .join('; ');
    // Name the override knob per source — Mezzanine and Theatr have SEPARATE
    // override tables in different scrapers; sending a Theatr-only gap to
    // MEZZANINE_OVERRIDES is the wrong fix.
    const sources = [...new Set(gaps.map(g => g.source))];
    const knob = sources.map(s => s === 'Theatr'
      ? 'THEATR_OVERRIDES in scrape-theatr-audience.js'
      : 'MEZZANINE_OVERRIDES ({name} or {name,venue}) in scrape-mezzanine-audience.js').join(' / ');
    // ≥3 open-show gaps is a systematic matcher problem (error); 1-2 is a warn.
    const status = gaps.length >= 3 ? 'error' : 'warn';
    return {
      name: 'Audience coverage: open-show gaps',
      status,
      message: `${gaps.length} open show(s) have audience data on a source that didn't link — ${top}`,
      hint: `Add an override for the flagged show: ${knob}; then re-run that source's scraper.`,
    };
  }));

  // B2b: Per-show social-pulse freshness. The `Freshness: social-pulse/_meta.json`
  // check above only proves the WORKFLOW ran — it can't see a still-running show
  // whose own file silently stopped refreshing (the update-social-pulse fetcher
  // can skip individual shows on partial failures). And a show whose status flips
  // away from open/previews leaves a frozen file forever. Both surfaced the School
  // Girls incident (file stuck at a 2026-04-13 fetch for 6+ weeks). We flag any
  // currently-running Broadway/West End show whose public .social.json is older
  // than the consumer staleness window (14 days, mirrors MAX_SOCIAL_PULSE_AGE_DAYS
  // in src/lib/data-social-pulse.ts) — those would be hidden from the show page +
  // /trending by the display guards, i.e. silently disappear from users.
  results.push(runCheck('Sync: social-pulse per-show freshness', () => {
    const STALE_DAYS = 14;
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    // Match the fetcher's scope (scripts/lib/list-running-shows.js): running
    // (open/previews) shows in the Broadway or West End markets. Off-Broadway is
    // out of scope for the social pipeline, so its missing files aren't gaps.
    const inScope = showList.filter(s =>
      (s.status === 'open' || s.status === 'previews') &&
      (isBroadwayCategory(s) || s.category === 'west-end'));
    const pulseDir = path.join(__dirname, '..', 'public', 'data', 'shows');

    const stale = [];
    for (const show of inScope) {
      const f = path.join(pulseDir, `${show.id}.social.json`);
      if (!fs.existsSync(f)) continue; // no file yet = cold-start, handled elsewhere
      let u;
      try { u = readJSON(f).u; } catch { continue; }
      const ageH = hoursAgo(u);
      if (ageH / 24 > STALE_DAYS) {
        stale.push({ title: show.title, days: Math.round(ageH / 24) });
      }
    }

    if (stale.length === 0) {
      return { name: 'Sync: social-pulse per-show freshness', status: 'pass', message: `${inScope.length} running BW/WE shows — no stale social-pulse files` };
    }
    stale.sort((a, b) => b.days - a.days);
    const sample = stale.slice(0, 5).map(s => `${s.title} (${s.days}d)`).join(', ');
    // A running show going stale is a real silent failure → warn (error if widespread).
    const status = stale.length > 5 ? 'error' : 'warn';
    return {
      name: 'Sync: social-pulse per-show freshness',
      status,
      message: `${stale.length} running show(s) with social-pulse >${STALE_DAYS}d stale: ${sample}`,
      hint: 'update-social-pulse ran but skipped these shows, or their status changed leaving a frozen file. Re-run: gh workflow run update-social-pulse.yml. They are currently hidden from show pages + /trending by the staleness guard.',
    };
  }));

  // B3: Phantom show detection — open shows with TBA venue and no reviews
  // Auto-discover can create phantom entries when isMultiProduction() treats TBA-venue
  // shows as distinct productions. These show up as open shows with no reviews and no venue.
  results.push(runCheck('Sync: phantom show detection', () => {
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));

    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const reviewedShowIds = new Set();
    for (const r of reviews.reviews || []) {
      if (r.showId) reviewedShowIds.add(r.showId);
    }

    const phantomCandidates = showList.filter(s =>
      s.status === 'open' &&
      !reviewedShowIds.has(s.id) &&
      !s.openingDate &&
      (s.venue === 'TBA' || s.venue === 'TBD' || !s.venue)
    );

    if (phantomCandidates.length === 0) {
      return { name: 'Sync: phantom show detection', status: 'pass', message: 'No phantom show candidates found' };
    }
    const names = phantomCandidates.map(s => s.id).join(', ');
    return {
      name: 'Sync: phantom show detection',
      status: 'warn',
      message: `${phantomCandidates.length} open show(s) with TBA venue, no reviews, no opening date: ${names}`,
      hint: 'These may be phantom shows created by auto-discover. Verify each is a real production, then add openingDate or real venue, or delete from shows.json.'
    };
  }));

  // B4: Cast coverage — open/previews Broadway shows missing cast data
  results.push(runCheck('Sync: cast coverage', () => {
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const castDir = path.join(DATA_DIR, 'cast');
    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const activeShows = showList.filter(s =>
      (s.status === 'open' || s.status === 'previews') &&
      isBroadwayCategory(s)
    );

    const missing = [];
    const empty = [];
    for (const show of activeShows) {
      const castFile = path.join(castDir, `${show.id}.json`);
      if (!fs.existsSync(castFile)) {
        missing.push(show.title);
      } else {
        try {
          const cast = readJSON(castFile);
          if (!cast.openingNightCast || cast.openingNightCast.length === 0) {
            empty.push(show.title);
          }
        } catch {}
      }
    }

    const total = missing.length + empty.length;
    if (total === 0) {
      return { name: 'Sync: cast coverage', status: 'pass', message: `${activeShows.length} active Broadway shows all have cast data` };
    }
    const parts = [];
    if (missing.length) parts.push(`${missing.length} missing file${missing.length > 1 ? 's' : ''}: ${missing.slice(0, 3).join(', ')}`);
    if (empty.length) parts.push(`${empty.length} empty cast: ${empty.slice(0, 3).join(', ')}`);
    const status = total > 3 ? 'error' : 'warn';
    return { name: 'Sync: cast coverage', status, message: parts.join('; '), hint: 'Run: node scripts/backfill-cast.js to repopulate' };
  }));

  // B5: Baseline drift
  results.push(runCheck('Sync: baseline drift', () => {
    const baselinePath = path.join(AUDIT_DIR, 'validation-baseline.json');
    if (!fs.existsSync(baselinePath)) {
      return { name: 'Sync: baseline drift', status: 'warn', message: 'No baseline file found' };
    }
    const baseline = readJSON(baselinePath);
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));

    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const currentTotal = showList.length;
    const currentOpen = showList.filter(s => s.status === 'open').length;
    const currentReviews = reviews._meta?.stats?.totalReviews || 0;

    const issues = [];
    let worstStatus = 'pass';

    if (currentTotal < baseline.totalShows) {
      worstStatus = 'warn';
      issues.push(`Shows dropped: ${currentTotal} vs baseline ${baseline.totalShows}`);
    }
    const openDrop = baseline.openShows - currentOpen;
    if (openDrop > 5) {
      worstStatus = 'error';
      issues.push(`Open shows dropped by ${openDrop}: ${currentOpen} vs baseline ${baseline.openShows}`);
    } else if (openDrop > 2) {
      worstStatus = 'warn';
      issues.push(`Open shows dropped by ${openDrop}: ${currentOpen} vs baseline ${baseline.openShows}`);
    }
    if (currentReviews < baseline.totalReviews) {
      worstStatus = 'warn';
      issues.push(`Reviews dropped: ${currentReviews} vs baseline ${baseline.totalReviews}`);
    }

    if (issues.length === 0) {
      return { name: 'Sync: baseline drift', status: 'pass', message: `${currentTotal} shows, ${currentOpen} open, ${currentReviews} reviews (all at or above baseline)` };
    }
    return { name: 'Sync: baseline drift', status: worstStatus, message: issues.join('; '), hint: 'Run validate-data.js to update baseline' };
  }));

  // B6: Grosses weekEnding currency — guards against timestamp refreshes masking stale content.
  // The lastUpdated timestamp in grosses.json can be refreshed by rebuilds without new scrape data.
  // This check reads weekEnding directly so a 2-week-old scrape can't hide behind a fresh timestamp.
  results.push(runCheck('Sync: grosses weekEnding', () => {
    const grossesPath = path.join(DATA_DIR, 'grosses.json');
    if (!fs.existsSync(grossesPath)) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: 'grosses.json missing' };
    }
    const grosses = readJSON(grossesPath);
    const weekEnding = grosses.weekEnding; // format "M/D/YYYY"
    if (!weekEnding) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: 'No weekEnding field in grosses.json' };
    }
    // Parse "M/D/YYYY" → Date
    const parts = weekEnding.split('/');
    if (parts.length !== 3) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: `Unparseable weekEnding: ${weekEnding}` };
    }
    const weekDate = new Date(`${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}T12:00:00Z`);
    const daysOld = (Date.now() - weekDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld > 21) {
      return { name: 'Sync: grosses weekEnding', status: 'error', message: `weekEnding ${weekEnding} is ${Math.round(daysOld)} days ago (3+ missed weeks)`, hint: 'weekly-grosses.yml scraper may be broken — check Actions tab' };
    }
    if (daysOld > 14) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: `weekEnding ${weekEnding} is ${Math.round(daysOld)} days ago (2 missed weeks)`, hint: 'Run: gh workflow run "Weekly Broadway Grosses"' };
    }
    return { name: 'Sync: grosses weekEnding', status: 'pass', message: `weekEnding ${weekEnding} (${Math.round(daysOld)}d ago)` };
  }));

  return results;
}

// --- Category C: Pipeline Health (warn only) ---

const PIPELINE_CHECKS = [
  { file: 'rebuild-reviews.last-success', label: 'rebuild-reviews', warnH: 48 },
  { file: 'update-show-status.last-success', label: 'update-show-status', warnH: 48 },
  { file: 'collect-review-texts.last-success', label: 'collect-review-texts', warnH: 48 },
  { file: 'weekly-grosses.last-success', label: 'weekly-grosses', warnH: 240 },
  { file: 'weekly-integrity.last-success', label: 'weekly-integrity', warnH: 240 },
  { file: 'test.last-success', label: 'test', warnH: 48 },
];

function checkPipelines() {
  return PIPELINE_CHECKS.map(({ file, label, warnH }) =>
    runCheck(`Pipeline: ${label}`, () => {
      const filePath = path.join(PIPELINE_DIR, file);
      if (!fs.existsSync(filePath)) {
        return { name: `Pipeline: ${label}`, status: 'warn', message: 'No timestamp file (workflow may not have run yet)' };
      }
      const content = fs.readFileSync(filePath, 'utf8').trim();
      const age = hoursAgo(content);
      if (age === Infinity) {
        return { name: `Pipeline: ${label}`, status: 'warn', message: `Unparseable timestamp: ${content}` };
      }
      if (age > warnH) {
        return { name: `Pipeline: ${label}`, status: 'warn', message: `Last success ${formatAge(age)} ago (threshold: ${formatAge(warnH)})` };
      }
      return { name: `Pipeline: ${label}`, status: 'pass', message: `Last success ${formatAge(age)} ago` };
    })
  );
}

// Task #547: index.ts's --batch mode (task #516) writes batchInFlight state to
// data/collection-state/scoring-batch-state.json but nothing read it — a batch
// that never finishes inside the poll budget scores zero new reviews and the
// only visible signal was `processed: 0`, indistinguishable from "nothing
// needed scoring". Vendors expire batches at 24h; BATCH_STATE_MAX_AGE_HOURS in
// index.ts discards at 48h, so an error at 24h gives a full day of lead time
// before the state is silently dropped.
const SCORING_BATCH_STATE_PATH = path.join(DATA_DIR, 'collection-state', 'scoring-batch-state.json');

/**
 * Pure so the age thresholds are testable without touching the filesystem.
 * Requires the same shape readBatchState() in index.ts requires (submittedAt +
 * an array manifest) — a corrupt-but-parseable file (e.g. `{submittedAt}`
 * alone) is not real batch state, and index.ts's own reader would ignore it.
 */
function batchStateResult(state) {
  const name = 'Scoring: batch state';
  if (!state || !state.submittedAt || !Array.isArray(state.manifest)) {
    return { name, status: 'pass', message: 'No batch in flight' };
  }
  const age = hoursAgo(state.submittedAt);
  if (age === Infinity) {
    return { name, status: 'warn', message: `scoring-batch-state.json has an unparseable submittedAt: ${state.submittedAt}` };
  }
  const itemCount = state.itemCount || 0;
  const ageLabel = formatAge(age);
  if (age > 24) {
    // index.ts itself only discards state past BATCH_STATE_MAX_AGE_HOURS=48 —
    // this is deliberately earlier: vendors expire the underlying batch job at
    // 24h, so results are already unrecoverable even though local bookkeeping
    // won't self-clear for another day. That gap is exactly the lead time
    // this check exists to surface, not a claim that 24h is the discard point.
    return {
      name,
      status: 'error',
      message: `Batch in flight ${ageLabel} (${itemCount} reviews) — the vendor batch has expired (24h) and its results are no longer retrievable; local state self-clears at 48h unless a run resumes and re-submits first`,
      hint: 'Check the scoring workflow run history for stalled/crashed polling — these reviews will be scored fresh once scoring-batch-state.json clears.',
    };
  }
  if (age > 12) {
    return { name, status: 'warn', message: `Batch in flight ${ageLabel} (${itemCount} reviews) — next run resumes polling` };
  }
  return { name, status: 'pass', message: `Batch in flight ${ageLabel} (${itemCount} reviews) — next run resumes polling` };
}

function checkBatchState() {
  return [runCheck('Scoring: batch state', () => {
    if (!fs.existsSync(SCORING_BATCH_STATE_PATH)) {
      return batchStateResult(null);
    }
    let state;
    try {
      state = readJSON(SCORING_BATCH_STATE_PATH);
    } catch (err) {
      return { name: 'Scoring: batch state', status: 'warn', message: `Unparseable scoring-batch-state.json: ${err.message}` };
    }
    return batchStateResult(state);
  })];
}

// --- Category D: Content Quality ---

function checkQuality() {
  return [
    // Star-vs-score contradiction detector (card #396, Birthright 2026-07-24).
    // A review's EXPLICIT critic rating (5-star rave) that ends up scored as a
    // pan means the rating was mis-extracted — classically, the wrong show's
    // star grabbed off a combined multi-show review column (Theater Life), then
    // winning score-routing. Alerts only on findings NOT in the committed
    // baseline (data/audit/star-score-mismatch-baseline.json) so the known
    // backlog stays quiet and a genuinely NEW mismatch surfaces the day it
    // appears — a time window would miss slow-burn cases (Birthright's bad
    // extraction predated the user report by 19 days). `/^Quality:/` playbook
    // route = this-week warn, not a page.
    runCheck('Quality: star-vs-score mismatch', () => {
      const { scanReviewTexts } = require('./lib/star-score-mismatch');
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: star-vs-score mismatch', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      let baselineKeys = new Set();
      try {
        const b = readJSON(path.join(AUDIT_DIR, 'star-score-mismatch-baseline.json'));
        if (b && Array.isArray(b.keys)) baselineKeys = new Set(b.keys);
      } catch { /* no baseline yet — everything is "new" */ }
      const { findings, baselinedCount } = scanReviewTexts(rtDir, { baselineKeys });
      if (findings.length === 0) {
        return { name: 'Quality: star-vs-score mismatch', status: 'pass', message: `No new star/score contradictions (${baselinedCount} known/baselined)` };
      }
      const worst = findings[0];
      const hidden = findings.filter(f => f.starWonHidingContradiction).length;
      return {
        name: 'Quality: star-vs-score mismatch',
        status: 'warn',
        message: `${findings.length} NEW review(s) whose explicit rating contradicts the score (worst: ${worst.showId} ${worst.outlet} ${worst.originalRating}→${worst.expected} vs LLM ${worst.llm}, gap ${worst.worstGap})${hidden ? `; ${hidden} star-won-hiding` : ''}`,
        hint: 'Run `node scripts/audit-star-score-mismatch.js` — likely a mis-extracted star (wrong show in a combined review column). Fix originalScore in review-texts + rescore, then `--write-baseline` to ack.',
      };
    }),

    runCheck('Quality: scored review ratio', () => {
      const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));
      const stats = reviews._meta?.stats || {};
      const scored = stats.totalReviews || 0;
      const noScore = stats.skippedNoScore || 0;
      const total = scored + noScore;
      if (total === 0) {
        return { name: 'Quality: scored review ratio', status: 'warn', message: 'No review stats available' };
      }
      const pct = ((scored / total) * 100).toFixed(1);
      if (pct < 35) {
        return { name: 'Quality: scored review ratio', status: 'warn', message: `${pct}% scored (${scored}/${total}) — below 35% threshold`, hint: 'LLM scoring may need attention' };
      }
      return { name: 'Quality: scored review ratio', status: 'pass', message: `${pct}% scored (${scored}/${total})` };
    }),

    // Surfaces the corpus-statistics drift monitor (check-corpus-drift.yml) in
    // the digest. Those audits (text-quality %, aggregator-truth ratios, regex
    // FP counts) were moved OUT of test.yml to non-blocking on 2026-06-21 so
    // they'd stop redding main as the rebuild bots drift the corpus every ~30
    // min. The workflow + workflows/CLAUDE.md both claimed they were "surfaced
    // in the daily digest by health-check.js" — but that wiring never existed,
    // so the signals were silently swallowed (advisory ≠ invisible). This is
    // that wiring: a drift audit that CANNOT RUN is an error (the monitor is
    // broken); drift itself is a `this-week` warn (via the /^Quality:/ playbook
    // route) so it shows in the digest without paging. Added 2026-06-22.
    runCheck('Quality: corpus drift', () => {
      const driftFile = path.join(AUDIT_DIR, 'corpus-drift.json');
      if (!fs.existsSync(driftFile)) {
        return { name: 'Quality: corpus drift', status: 'warn', message: 'No corpus-drift data (check-corpus-drift.yml may not have run)', hint: 'Trigger the "Check Corpus Drift" workflow' };
      }
      const data = readJSON(driftFile);
      const ts = data?._meta?.generatedAt;
      const age = ts ? hoursAgo(ts) : Infinity;
      // Daily cron + post-rebuild; 36h means it's missed a day of runs.
      if (age > 36) {
        return { name: 'Quality: corpus drift', status: 'warn', message: `Drift monitor last ran ${formatAge(age)} ago (>36h)`, hint: 'check-corpus-drift.yml may be stale/disabled' };
      }
      const audits = Array.isArray(data?.audits) ? data.audits : [];
      const crashed = audits.filter(a => a.crashed);
      if (crashed.length > 0) {
        // A drift audit that can't even run is a real problem, not drift.
        return { name: 'Quality: corpus drift', status: 'error', message: `${crashed.length} drift audit(s) crashed: ${crashed.map(a => a.name).join(', ')}`, hint: 'A corpus-statistics audit cannot scan — see data/audit/corpus-drift.json' };
      }
      const drifted = audits.filter(a => !a.ok && !a.crashed);
      if (drifted.length > 0) {
        return { name: 'Quality: corpus drift', status: 'warn', message: `${drifted.length} audit(s) drifting: ${drifted.map(a => a.label || a.name).join(', ')}`, hint: 'Non-blocking corpus drift — review data/audit/corpus-drift.json' };
      }
      return { name: 'Quality: corpus drift', status: 'pass', message: `${audits.length} audits within thresholds (${formatAge(age)} ago)` };
    }),

    // Silent-exclusion detectors (#1147 tracker, card #1188): a pipeline stage
    // refuses to include a review and records nothing an operator would ever
    // look at. Two live incidents, both fixed by hand with no detector left
    // behind — this is that detector, wired into the existing daily digest
    // rather than a new cron. Advisory `this-week` warns via the /^Quality:/
    // playbook route, not a page: both predicates report CANDIDATES for a
    // human to confirm, never write.
    runCheck('Quality: missing contentTier', () => {
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: missing contentTier', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const { scanMissingContentTier } = require('./lib/silent-exclusion-detectors');
      let showsById = {};
      try {
        const showsArr = readJSON(path.join(DATA_DIR, 'shows.json'));
        for (const s of (Array.isArray(showsArr) ? showsArr : showsArr.shows) || []) {
          if (s && s.id) showsById[s.id] = s;
        }
      } catch { /* shows.json unreadable — scan degrades to no show-context checks */ }
      let hits = scanMissingContentTier(rtDir, showsById);
      // rebuild-all-reviews.js reclassifies contentTier unconditionally on
      // every pass (in-memory, before the review is pushed to reviews.json),
      // so a source file missing contentTier does NOT necessarily mean the
      // review is currently absent — only that its source file's write-back
      // failed or hasn't run yet. Cross-check against the live reviews.json
      // so this check reports the residual gap, not every stale source file.
      const reviewsPath = path.join(DATA_DIR, 'reviews.json');
      if (hits.length > 0 && fs.existsSync(reviewsPath)) {
        try {
          const live = readJSON(reviewsPath);
          // Keyed by url+showId, not url alone (ship-check finding): a
          // review URL reused across two DIFFERENT shows (rare, but review
          // URLs aren't validated globally-unique) must not let one show's
          // live entry suppress a genuine gap under a different show.
          const liveUrlShowKeys = new Set(
            (live.reviews || []).map((r) => (r.url ? `${r.url}|${r.showId}` : null)).filter(Boolean),
          );
          const liveTriples = new Set(
            (live.reviews || []).map((r) => `${r.showId}|${String(r.outletId || '').toLowerCase()}|${String(r.criticName || '').toLowerCase().trim()}`),
          );
          // Match on url+showId FIRST when the hit has a url: two review-text
          // files can share showId+outletId+criticName (a republished
          // article, or byline-enrichment landing on two separate URLs) — the
          // coarser triple match alone would let one file already live in
          // reviews.json mask the OTHER file's genuine gap (ship-check
          // finding). Only fall back to the triple match when the hit has no
          // url to compare.
          hits = hits.filter((h) => {
            if (h.url) return !liveUrlShowKeys.has(`${h.url}|${h.showId}`);
            return !liveTriples.has(`${h.showId}|${String(h.outletId || '').toLowerCase()}|${String(h.criticName || '').toLowerCase().trim()}`);
          });
        } catch { /* reviews.json unreadable — report the unfiltered (safe-direction) hit list */ }
      }
      if (hits.length === 0) {
        return { name: 'Quality: missing contentTier', status: 'pass', message: 'No scored reviews missing contentTier' };
      }
      const worst = hits[0];
      return {
        name: 'Quality: missing contentTier',
        status: 'warn',
        message: `${hits.length} review(s) have fullText + a real byline + no rejection flags but NO contentTier, and are NOT in reviews.json (e.g. ${worst.showId}/${worst.file})`,
        hint: 'A review-text file lost its contentTier without fullText changing, so rebuild never re-derives it. Run classifyContentTier on it and restore contentTier by hand, or add contentTier to the show\'s review file directly.',
      };
    }),

    runCheck('Quality: outlet domain moves', () => {
      const registryPath = path.join(DATA_DIR, 'outlet-registry.json');
      const censusPath = path.join(AUDIT_DIR, 'unknown-aggregator-outlets.json');
      if (!fs.existsSync(registryPath) || !fs.existsSync(censusPath)) {
        return { name: 'Quality: outlet domain moves', status: 'pass', message: 'Skipped (registry or unknown-outlet census not present)' };
      }
      const { findProbableDomainMoves } = require('./lib/silent-exclusion-detectors');
      let outlets, census;
      try {
        outlets = readJSON(registryPath)?.outlets;
        census = readJSON(censusPath);
      } catch (parseErr) {
        // A malformed/mid-write file is a soft signal (retry next run), not a
        // crash — matches the sibling checks' pattern (e.g. Sync: grosses
        // weekEnding, Scoring: batch state) rather than falling through to
        // runCheck's generic try/catch, which would report 'error' and feed
        // the digest's escalation path for what's really a transient read.
        return { name: 'Quality: outlet domain moves', status: 'warn', message: `Could not parse registry or census: ${parseErr.message}`, hint: 'Likely a mid-write file — should clear on the next run' };
      }
      const ts = census?.generatedAt;
      const age = ts ? hoursAgo(ts) : Infinity;
      if (age > 48) {
        return { name: 'Quality: outlet domain moves', status: 'warn', message: `Unknown-outlet census is ${formatAge(age)} old (>48h)`, hint: 'The census that this check mines may be stale — check what writes data/audit/unknown-aggregator-outlets.json' };
      }
      const moves = findProbableDomainMoves(outlets, census?.outlets || []);
      if (moves.length === 0) {
        return { name: 'Quality: outlet domain moves', status: 'pass', message: `No probable domain moves in ${census?.outlets?.length || 0} unregistered host(s)` };
      }
      const worst = moves[0];
      return {
        name: 'Quality: outlet domain moves',
        status: 'warn',
        message: `${moves.length} unregistered host(s) name-match a registered outlet (e.g. ${worst.host} → ${worst.outletId}) — probable domain move dropping reviews via domain-mismatch`,
        hint: 'Confirm the host really belongs to that outlet, then add it to that outlet\'s domainAliases in data/outlet-registry.json.',
      };
    }),

    // Outlet stub-rate monitor (card #100): when an outlet redesigns its
    // site, its article-extractor.js pattern can silently stop matching —
    // extractArticleTextFromUrl returns 0 chars, the review saves as
    // contentTier:stub, and it never scores. Nothing alerted on this until
    // TheaterMania's 2026 Bootstrap redesign left 26 reviews stuck as stubs
    // corpus-wide, caught only by accident chasing one unrelated show. A
    // healthy outlet has old/legacy stub debt; a broken extractor produces a
    // SPIKE in the stub rate among reviews collected in the last 30 days —
    // that's the signal computeOutletStubRates() looks for. Advisory
    // `this-week` warn via the /^Quality:/ playbook route, not a page: it
    // reports a candidate for a human to confirm (real redesign vs. a run of
    // genuinely un-extractable pages), never writes.
    runCheck('Quality: outlet stub rate', () => {
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: outlet stub rate', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const { collectReviewRecords, computeOutletStubRates } = require('./audit-outlet-stub-rate.js');
      const records = collectReviewRecords(rtDir);
      const { outlets, flaggedOutletIds } = computeOutletStubRates(records);
      if (flaggedOutletIds.length === 0) {
        return { name: 'Quality: outlet stub rate', status: 'pass', message: `No broken-extractor signature in ${outlets.length} outlet(s), ${records.length} review(s)` };
      }
      const worst = outlets.find((o) => o.outletId === flaggedOutletIds[0]);
      return {
        name: 'Quality: outlet stub rate',
        status: 'warn',
        message: `${flaggedOutletIds.length} outlet(s) show a broken-extractor signature (worst: ${worst.outletId} — ${worst.recentStubCount}/${worst.recentTotal} recent stubs, ${(worst.recentStubRate * 100).toFixed(0)}%)`,
        hint: 'Run `node scripts/audit-outlet-stub-rate.js` — likely a redesigned article-extractor.js pattern no longer matching. See tests/unit/theatermania-extractor.test.mjs for the fix pattern (regression test + updated extraction pattern).',
      };
    }),

    // Outlet invalid-content-rate monitor (card #1244, generalizing #100):
    // same broken-extractor failure mode as the stub check above, but for
    // extractions that DID return something — just not real article text
    // (cookie wall, 404-as-200, boilerplate; isGarbageContent() in
    // content-quality.js). 'invalid' is 23x larger corpus-wide than 'stub'
    // and includes outlets that are chronically near-100% invalid
    // (paywalled/bot-blocked, not newly broken) — computeOutletInvalidRates()
    // additionally requires the recent rate to SPIKE over the outlet's own
    // pre-window baseline so those don't cry wolf every day. It also excludes
    // wrongProduction/wrongShow-reasoned 'invalid' records by default (card
    // #1266) — that's a different classifyContentTier() code path (extractor
    // is fine, wrong show matched) with its own FP sweep (tasks #24/#243), not
    // an extractor-health signal. Same advisory `this-week` warn via the
    // /^Quality:/ playbook route, never writes.
    runCheck('Quality: outlet invalid-content rate', () => {
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: outlet invalid-content rate', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const { collectReviewRecords, computeOutletInvalidRates } = require('./audit-outlet-stub-rate.js');
      const records = collectReviewRecords(rtDir);
      const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records);
      if (flaggedOutletIds.length === 0) {
        return { name: 'Quality: outlet invalid-content rate', status: 'pass', message: `No broken-extractor signature in ${outlets.length} outlet(s), ${records.length} review(s)` };
      }
      const worst = outlets.find((o) => o.outletId === flaggedOutletIds[0]);
      return {
        name: 'Quality: outlet invalid-content rate',
        status: 'warn',
        message: `${flaggedOutletIds.length} outlet(s) show a broken-extractor signature (worst: ${worst.outletId} — ${worst.recentInvalidCount}/${worst.recentTotal} recent invalid, ${(worst.recentInvalidRate * 100).toFixed(0)}% vs ${(worst.baselineInvalidRate * 100).toFixed(0)}% baseline)`,
        hint: 'Run `node scripts/audit-outlet-stub-rate.js` — wrongProduction/wrongShow-reasoned records are excluded from this check (see tasks #24/#243 for that FP sweep), so a flag here should be a genuine article-extractor.js regression. Spot-check contentTierReason on the flagged files to confirm before diving in.',
      };
    }),

    // Affiliate revenue-stream monitor (affiliate hardening plan 2026-08-03).
    // check-affiliate-health.js runs earlier in the same data-health-check.yml
    // job and writes this snapshot; this line is (a) the digest surface for
    // its findings and (b) the monitor's own dead-man — a monitor that stops
    // writing its snapshot looks exactly like a healthy pipeline to any check
    // that only reads the last row (the arm-yield 'unobserved' lesson). This
    // is the site's ONLY revenue stream: a stale/broken monitor is an error,
    // not a warn.
    runCheck('Revenue: affiliate health', () => {
      const snapFile = path.join(AUDIT_DIR, 'affiliate-health.json');
      if (!fs.existsSync(snapFile)) {
        return { name: 'Revenue: affiliate health', status: 'warn', message: 'No affiliate-health snapshot yet (monitor not yet run)', hint: 'node scripts/check-affiliate-health.js --dry-run' };
      }
      const snap = readJSON(snapFile);
      const age = snap?.updatedAt ? hoursAgo(snap.updatedAt) : Infinity;
      if (age > 48) {
        return { name: 'Revenue: affiliate health', status: 'error', message: `Affiliate monitor snapshot is ${formatAge(age)} old (>48h) — the revenue-stream monitor itself is dead`, hint: 'Check the "Affiliate health monitor" step in data-health-check.yml' };
      }
      const checks = Array.isArray(snap?.checks) ? snap.checks : [];
      const criticals = checks.filter(c => c.verdict === 'critical');
      const warns = checks.filter(c => c.verdict === 'warn');
      const shadowTag = snap.shadow ? ' [shadow burn-in]' : '';
      if (criticals.length > 0) {
        return { name: 'Revenue: affiliate health', status: 'error', message: `${criticals.length} critical: ${criticals.map(c => c.label).join(', ')}${shadowTag}`, hint: criticals[0].reason };
      }
      if (warns.length > 0) {
        return { name: 'Revenue: affiliate health', status: 'warn', message: `${warns.length} anomaly: ${warns.map(c => c.label).join(', ')}${shadowTag}`, hint: warns[0].reason };
      }
      return { name: 'Revenue: affiliate health', status: 'pass', message: `${checks.length} checks healthy (${formatAge(age)} ago)${shadowTag}` };
    }),

    // Coverage Verdict S1 (tasks #872 + #898). #872 measured SERP-census recall
    // once, after four owner spot-checks in a row found published reviews the
    // census reported absent — then nothing measured it again, so the next arm
    // regression would be invisible exactly the way the last four were. The
    // weekly audit-census-recall.yml cron writes the verdict here; this is what
    // makes it something the owner sees rather than a file nobody opens.
    //
    // A regression is a warn, not an error: recall is a measurement, and the
    // gate it feeds (S2+) is fail-open by design. An error is reserved for the
    // DETECTOR being broken — no data, or stale data, which means the cadence
    // itself has stopped and the blindness is back.
    runCheck(CENSUS_RECALL_CHECK, () => {
      const statusFile = path.join(AUDIT_DIR, 'census-recall-status.json');
      if (!fs.existsSync(statusFile)) return censusRecallResult(null);
      let data;
      try {
        data = readJSON(statusFile);
      } catch (err) {
        return { name: CENSUS_RECALL_CHECK, status: 'warn', message: `Unparseable census-recall-status.json: ${err.message}` };
      }
      return censusRecallResult(data);
    }),

    // Coverage Verdict S5 (task #903, the FINAL sprint). Findings surface
    // here — never as email spam or a blocking CI run — because the plan is
    // explicit that a seeded adversarial finding is this-week work, not a
    // page. An error is reserved for the detector itself going quiet.
    runCheck(COVERAGE_PROBE_CHECK, () => {
      const statusFile = path.join(AUDIT_DIR, 'coverage-adversarial-probe-status.json');
      if (!fs.existsSync(statusFile)) return coverageProbeResult(null);
      let data;
      try {
        data = readJSON(statusFile);
      } catch (err) {
        return { name: COVERAGE_PROBE_CHECK, status: 'warn', message: `Unparseable coverage-adversarial-probe-status.json: ${err.message}` };
      }
      return coverageProbeResult(data);
    }),
  ];
}

const CENSUS_RECALL_CHECK = 'Coverage: SERP census recall';
/** Weekly cron; past this the detector has missed a run outright. */
const CENSUS_RECALL_MAX_AGE_HOURS = 24 * 9;

/**
 * Render the census-recall verdict as a digest check (Coverage Verdict S1,
 * tasks #872 + #898).
 *
 * Severity, and why it is not the other way round:
 *   · a REGRESSION is a warn. Recall is a measurement, and the gate it
 *     eventually feeds (S2+) is fail-open by design — an error here would page
 *     the owner over a number that suppresses nothing.
 *   · MISSING or STALE data is also surfaced rather than skipped, because that
 *     means the cadence itself has stopped and the #898 blindness is back. A
 *     detector that goes quiet must never read as health (the #647 lesson).
 *
 * Pure so it can be tested against fixtures without a live audit file
 * (CLAUDE.md rule 15); checkQuality() supplies the I/O.
 *
 * @param {object|null} data parsed data/audit/census-recall-status.json
 * @param {object} [opts] {nowMs} for deterministic age in tests
 */
function censusRecallResult(data, opts = {}) {
  const name = CENSUS_RECALL_CHECK;
  if (!data) {
    return { name, status: 'warn', message: 'No census-recall data (audit-census-recall.yml may not have run yet)', hint: 'Run `gh workflow run "Audit Census Recall"`' };
  }
  const now = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const ts = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  const age = Number.isFinite(ts) ? (now - ts) / 3600000 : Infinity;
  if (age > CENSUS_RECALL_MAX_AGE_HOURS) {
    return {
      name, status: 'warn',
      message: `Recall last measured ${formatAge(age)} ago (weekly cron, >${CENSUS_RECALL_MAX_AGE_HOURS / 24}d)`,
      hint: 'audit-census-recall.yml may be stale or disabled — the regression detector is blind while it is.',
    };
  }

  const latest = data.latest || {};
  const summary = Object.entries(latest.families || {})
    .map(([f, r]) => `${SEARCH_METHOD_LABELS[f] || f} found ${pctOf(r)}`)
    .join(', ');
  const scope = `across ${latest.shows ?? 0} recent opening(s); ${latest.truthUrls ?? 0} review pages any of our searches could find`;

  if (data.verdict === 'regressed') {
    const worst = (data.regressions || [])
      .map(r => `${SEARCH_METHOD_LABELS[r.arm] || r.arm} ${r.current === null ? 'stopped reporting' : `now finds ${pctOf(r.current)} vs ${pctOf(r.baseline)} recently`}`)
      .join('; ');
    return {
      name, status: 'warn',
      message: `Review coverage dropped — ${worst} (${scope}). New shows may be going live with published reviews missing.`,
      hint: 'Run `node scripts/audit-serp-census-recall.js --sample=10` and compare per-arm recall; a dead query slot or a provider outage is the usual cause.',
    };
  }
  if (data.verdict === 'blind' || data.verdict === 'insufficient-sample') {
    return {
      name, status: 'warn',
      message: `Review coverage not judgeable yet: ${data.reason || data.verdict}`,
      hint: 'Needs more weekly runs on record before a drop can be detected.',
    };
  }
  return {
    name, status: 'pass',
    message: `${summary || 'no search methods recorded'} — ${scope}; ${data.comparedArms ?? 0} search method(s) steady vs recent weeks (${formatAge(age)} ago)`,
  };
}

const COVERAGE_PROBE_CHECK = 'Coverage: adversarial probe';
/** Weekly cron; past this the probe has missed a run outright. */
const COVERAGE_PROBE_MAX_AGE_HOURS = 24 * 9;

/**
 * Render the Coverage Verdict S5 adversarial-probe verdict as a digest check
 * (task #903, the FINAL sprint).
 *
 * A found gap is a warn, not an error: it is a real, current finding that
 * needs a human to ingest or explain the review, but the pipeline is not
 * broken by it existing (it exists precisely because the pipeline has not
 * caught up yet). An error is reserved for the DETECTOR going quiet — no
 * data, or stale data — which means the weekly cadence has stopped and this
 * check can no longer see anything at all.
 *
 * Pure so it can be tested against fixtures without a live audit file.
 *
 * @param {object|null} data parsed data/audit/coverage-adversarial-probe-status.json
 * @param {object} [opts] {nowMs} for deterministic age in tests
 */
function coverageProbeResult(data, opts = {}) {
  const name = COVERAGE_PROBE_CHECK;
  if (!data) {
    return { name, status: 'warn', message: 'No adversarial-probe data (coverage-adversarial-probe.yml may not have run yet)', hint: 'Run `gh workflow run "Coverage Adversarial Probe"`' };
  }
  const now = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const ts = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  const age = Number.isFinite(ts) ? (now - ts) / 3600000 : Infinity;
  if (age > COVERAGE_PROBE_MAX_AGE_HOURS) {
    return {
      name, status: 'warn',
      message: `Probe last ran ${formatAge(age)} ago (weekly cron, >${COVERAGE_PROBE_MAX_AGE_HOURS / 24}d)`,
      hint: 'coverage-adversarial-probe.yml may be stale or disabled — the probe is blind while it is.',
    };
  }

  if (data.verdict === 'gaps-found') {
    const shows = (data.gapShows || []).join(', ') || 'unnamed show(s)';
    return {
      name, status: 'warn',
      message: `The naive search found ${data.gapCount ?? '?'} review URL(s) this pipeline hasn't discovered yet: ${shows}`,
      hint: 'See data/audit/coverage-adversarial-probe.json for the URLs, then ingest or explain each one.',
    };
  }
  if (data.verdict === 'inconclusive') {
    return {
      name, status: 'warn',
      message: `This week's sample had nothing measurable (settling/undated shows, or a SERP outage) — no evidence either way`,
      hint: 'Not a failure — the next weekly run should have a measurable sample.',
    };
  }
  const acceptance = data.acceptance || {};
  const acceptedNote = acceptance.accepted ? ' — 2 consecutive clean weeks, acceptance bar cleared' : '';
  return {
    name, status: 'pass',
    message: `Every discovered review URL was live or named-excluded (${formatAge(age)} ago)${acceptedNote}`,
  };
}

// The owner reads this line in a morning email among ~30 others. "scoped",
// "naive", "onDisk", "arm" and "recall 0.28" are internal vocabulary; a
// fresh-eyes review (2026-08-02) confirmed every one of them stops a
// non-engineer reader, and that a bare ratio invites a wrong conclusion
// because nothing says whether 0.28 is normal.
const SEARCH_METHOD_LABELS = {
  scoped: 'our targeted searches',
  naive: 'a plain Google search',
  onDisk: 'reviews already collected',
};
/** 0.283 -> "28%". The percentage is what a reader actually parses. */
function pctOf(r) {
  return typeof r === 'number' && Number.isFinite(r) ? `${Math.round(r * 100)}%` : 'n/a';
}

// --- Outlet health signals (card #641) ---
// standingCoverage drift (card #627), coverageExpectation drift (card #640), and
// outlet-heartbeat red flags (card #582/#299) were all computed correctly but
// dead-ended in an unread GH Actions step summary of a weekly unattended cron —
// nobody opens that run to scroll it. Same fix as "Quality: corpus drift" above:
// give each signal a digest row so it's visible without opening Actions.
function loadOutletHealthCoreData() {
  const showsFile = path.join(DATA_DIR, 'shows.json');
  const reviewsFile = path.join(DATA_DIR, 'reviews.json');
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (!fs.existsSync(showsFile) || !fs.existsSync(reviewsFile) || !fs.existsSync(registryFile)) {
    return null;
  }
  // Called directly in checkOutletHealth() (not through runCheck), so a
  // concurrent writer leaving one of these files mid-write/truncated must not
  // throw here — that would escape to main().catch() and kill the whole
  // digest, sending no email at all (ship-check finding, 2026-07-30).
  try {
    return {
      shows: readJSON(showsFile).shows,
      reviews: readJSON(reviewsFile).reviews,
      outlets: readJSON(registryFile).outlets,
    };
  } catch {
    return null;
  }
}

function checkOutletHealth() {
  const core = loadOutletHealthCoreData();

  return [
    // standingCoverage is DERIVED from measured Broadway coverage (card #627) —
    // recomputed live off current core data every run, same as the source
    // audit-standing-coverage.js script does, so no separate snapshot file or
    // staleness window is needed.
    runCheck('Quality: standingCoverage drift', () => {
      if (!core) {
        return { name: 'Quality: standingCoverage drift', status: 'pass', message: 'Skipped (core data not checked out)' };
      }
      const { evaluateStandingCoverage } = require('./audit-standing-coverage');
      const result = evaluateStandingCoverage(core.shows, core.reviews, core.outlets, Date.now());
      const drifted = result.promote.length + result.demote.length;
      if (drifted === 0) {
        return { name: 'Quality: standingCoverage drift', status: 'pass', message: 'No standingCoverage drift' };
      }
      const parts = [];
      if (result.promote.length) parts.push(`promote: ${result.promote.join(', ')}`);
      if (result.demote.length) parts.push(`demote: ${result.demote.join(', ')}`);
      return {
        name: 'Quality: standingCoverage drift',
        status: 'warn',
        message: `${drifted} outlet(s) drifted from outlet-registry.json standingCoverage flags (${parts.join('; ')})`,
        hint: 'Run `node scripts/audit-standing-coverage.js` and update outlet-registry.json standingCoverage flags.',
      };
    }),

    // coverageExpectation ("this outlet does NOT review theatre") claims decay
    // on their own DECAY_DAYS window (card #640) — same live recompute, no
    // snapshot file.
    runCheck('Quality: coverageExpectation drift', () => {
      if (!core) {
        return { name: 'Quality: coverageExpectation drift', status: 'pass', message: 'Skipped (core data not checked out)' };
      }
      const { evaluateCoverageExpectationDrift } = require('./audit-standing-coverage');
      const result = evaluateCoverageExpectationDrift(core.shows, core.reviews, core.outlets, Date.now());
      if (result.needsReprobe.length === 0) {
        return { name: 'Quality: coverageExpectation drift', status: 'pass', message: 'No coverageExpectation re-probes needed' };
      }
      return {
        name: 'Quality: coverageExpectation drift',
        status: 'warn',
        message: `${result.needsReprobe.length} outlet(s) need coverageExpectation re-decision: ${result.needsReprobe.join(', ')}`,
        hint: 'Run `node scripts/audit-standing-coverage.js --coverage-expectation` and update outlet-registry.json coverageExpectation/coverageExpectationDecidedAt.',
      };
    }),

    // outlet-heartbeat DOES have a persisted weekly snapshot (committed by
    // audit-critic-coverage.yml) — read it and check staleness, same posture
    // as "Quality: corpus drift". Actionability is gated on the SAME
    // redStreak>=2 threshold outlet-heartbeat-state.js already uses for its
    // Discord ACTION alert (data/audit/outlet-heartbeat-state.json,
    // updateHeartbeatState()) rather than raw current-run status==='red' —
    // a single red week is deliberately treated as noise there (long-silent
    // outlets like newsday sit red every week), so re-warning on every row
    // that's merely red-this-week would just recreate the "unread signal"
    // problem this card exists to fix (ship-check finding, 2026-07-30).
    // 29 outlet×market rows are already redStreak=1 as of 2026-07-30 and will
    // likely all cross the threshold together on the next Monday cron — some
    // (newsday::broadway, backstage::broadway) have been silent for YEARS.
    // Same "known backlog vs genuinely new" split as "Quality: star-vs-score
    // mismatch" above: alert only on rows NOT in the committed baseline
    // (data/audit/outlet-heartbeat-baseline.json, card #643).
    runCheck('Quality: outlet-heartbeat red flags', () => {
      const heartbeatFile = path.join(AUDIT_DIR, 'outlet-heartbeat.json');
      if (!fs.existsSync(heartbeatFile)) {
        return { name: 'Quality: outlet-heartbeat red flags', status: 'warn', message: 'No outlet-heartbeat.json (audit-critic-coverage.yml may not have run)', hint: 'Trigger the "Audit Critic Coverage" workflow' };
      }
      const data = readJSON(heartbeatFile);
      const age = data?.generatedAt ? hoursAgo(data.generatedAt) : Infinity;
      // Weekly cron; 8 days means it's missed a week's run.
      if (age > 192) {
        return { name: 'Quality: outlet-heartbeat red flags', status: 'warn', message: `Heartbeat monitor last ran ${formatAge(age)} ago (>8d)`, hint: 'audit-critic-coverage.yml may be stale/disabled' };
      }
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const stateFile = path.join(AUDIT_DIR, 'outlet-heartbeat-state.json');
      const state = fs.existsSync(stateFile) ? readJSON(stateFile) : {};
      let baselineKeys = new Set();
      try {
        const b = readJSON(path.join(AUDIT_DIR, 'outlet-heartbeat-baseline.json'));
        if (b && Array.isArray(b.keys)) baselineKeys = new Set(b.keys);
      } catch { /* no baseline yet — everything is "new" */ }
      const { getActionableOutletRows } = require('./lib/outlet-heartbeat-state');
      const { actionable, baselinedCount } = getActionableOutletRows(rows, state, baselineKeys);
      if (actionable.length === 0) {
        return { name: 'Quality: outlet-heartbeat red flags', status: 'pass', message: `${rows.length} outlet×market rows checked, none NEW silent 2+ consecutive weeks (${baselinedCount} known/baselined, ${formatAge(age)} ago)` };
      }
      const worst = actionable[0];
      return {
        name: 'Quality: outlet-heartbeat red flags',
        status: 'warn',
        message: `${actionable.length} NEW T1/T2 outlet×market row(s) silent 2+ consecutive weekly checks (worst: ${worst.outletId}/${worst.market}, ${worst.silentDays}d silent vs ${worst.thresholdDays}d threshold; ${baselinedCount} known/baselined)`,
        hint: 'Run `node scripts/monitor-outlet-recency.js` — check whether the outlet stopped reviewing or an extractor broke (card #582 class). `--write-baseline` acks the ENTIRE current red backlog at once (not just the worst offender) — only run it once every currently-red outlet has been triaged.',
      };
    }),
  ];
}

// --- Commercial model drift (S2-T3) ---
// Surfaces the rolling history written by audit-commercial-data.js
// --write-history (S2-T1, called weekly from commercial-weekly.yml — S2-T2):
// modelDesignationFlag contradiction count and ai-estimated-tier count,
// week over week. Same posture as "Quality: corpus drift" above — drift
// itself is a `this-week` warn (visible in the digest, not paging); a
// missing/unreadable history file is also a warn (informational monitor,
// not a ship-blocker) since a first-ever week or a not-yet-run cron
// legitimately has no file yet.
function checkCommercialModelDrift() {
  return [
    runCheck('Commercial model drift', () => {
      const historyFile = path.join(AUDIT_DIR, 'commercial-data-history.json');
      if (!fs.existsSync(historyFile)) {
        return {
          name: 'Commercial model drift',
          status: 'warn',
          message: 'No commercial-data-history.json (commercial-weekly.yml may not have run --write-history yet)',
          hint: 'Trigger commercial-weekly.yml or check S2-T1/S2-T2 wiring',
        };
      }
      let history;
      try {
        history = readJSON(historyFile);
      } catch (err) {
        return { name: 'Commercial model drift', status: 'error', message: `Failed to parse commercial-data-history.json: ${err.message}` };
      }
      const result = computeCommercialModelDriftStatus(history);
      return { name: 'Commercial model drift', status: result.status, message: result.message, hint: result.hint };
    }),
  ];
}

// --- Category E: Cookie Expiration ---

const COOKIE_DIR = path.join(DATA_DIR, 'cookies');
const COOKIE_WARN_DAYS = 7;
const COOKIE_ERROR_DAYS = 2;
const CRITICAL_COOKIE_OUTLETS = new Set([
  'wsj', 'nytimes', 'newyorker', 'washpost', 'financialtimes', 'vulture', 'timeout'
]);

function checkCookieExpiration() {
  const results = [];
  // Cookies are managed on the Mac Studio (data/cookies/ is gitignored for security).
  // In CI the directory will always be missing — that's expected, not a problem.
  if (process.env.GITHUB_ACTIONS) {
    results.push({ name: 'Cookies: expiration', status: 'pass', message: 'Skipped in CI (cookies managed on Mac Studio)' });
    return results;
  }
  if (!fs.existsSync(COOKIE_DIR)) {
    results.push({ name: 'Cookies: expiration', status: 'warn', message: 'data/cookies/ not found', hint: 'Run: python3 scripts/extract-safari-cookies.py' });
    return results;
  }

  // Skip sidecar/meta files (e.g. _extracted-at.json) and quarantined files.
  const files = fs.readdirSync(COOKIE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  if (files.length === 0) {
    results.push({ name: 'Cookies: expiration', status: 'warn', message: 'No cookie files found' });
    return results;
  }

  const now = Date.now() / 1000;
  const details = [];

  for (const file of files) {
    const outlet = file.replace('.json', '');
    const isCritical = CRITICAL_COOKIE_OUTLETS.has(outlet);
    try {
      const cookies = JSON.parse(fs.readFileSync(path.join(COOKIE_DIR, file), 'utf8'));
      if (!Array.isArray(cookies) || cookies.length === 0) continue;

      const validCookies = cookies.filter(c => c.expires && c.expires > 0);
      if (validCookies.length === 0) continue;

      const latestExpiry = Math.max(...validCookies.map(c => c.expires));
      const daysLeft = (latestExpiry - now) / (60 * 60 * 24);

      if (daysLeft <= COOKIE_WARN_DAYS) {
        details.push({ outlet, daysLeft: Math.round(daysLeft * 10) / 10, isCritical });
      }
    } catch (e) {
      details.push({ outlet, daysLeft: -1, isCritical, error: e.message });
    }
  }

  if (details.length > 0) {
    const criticalIssues = details.filter(d => d.isCritical);
    const status = criticalIssues.some(d => d.daysLeft <= COOKIE_ERROR_DAYS) ? 'error'
      : criticalIssues.length > 0 ? 'warn'
      : details.some(d => d.daysLeft <= 0) ? 'warn'
      : 'pass';

    const expired = details.filter(d => d.daysLeft <= 0).length;
    const expiring = details.filter(d => d.daysLeft > 0).length;
    const summary = details
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 5)
      .map(d => `${d.outlet}${d.isCritical ? '*' : ''}: ${d.daysLeft <= 0 ? 'EXPIRED' : d.daysLeft + 'd left'}`)
      .join(', ');

    // Include per-cookie countdown for the digest
    const cookieCountdowns = details.map(d => {
      const days = Math.round(d.daysLeft);
      if (days < 0) return `${d.outlet}: EXPIRED (${Math.abs(days)}d ago)`;
      if (days < 3) return `${d.outlet}: ${days}d left`;
      if (days < 7) return `${d.outlet}: ${days}d left`;
      return null;
    }).filter(Boolean);

    results.push({
      name: 'Cookies: expiration',
      status,
      message: `${expired} expired, ${expiring} expiring <${COOKIE_WARN_DAYS}d — ${summary}`,
      hint: 'Run: python3 scripts/extract-safari-cookies.py then gh secret set <NAME> < /tmp/<file>.txt',
      cookieCountdowns,
    });
  } else {
    results.push({
      name: 'Cookies: expiration',
      status: 'pass',
      message: `${files.length} cookie files, all valid >${COOKIE_WARN_DAYS}d`,
    });
  }

  return results;
}

// --- Category F: Core Web Vitals ---

function checkCWV() {
  return [
    runCheck('CWV: performance', () => {
      const cwvFile = path.join(AUDIT_DIR, 'cwv-results.json');
      if (!fs.existsSync(cwvFile)) {
        return { name: 'CWV: performance', status: 'warn', message: 'No CWV data (check-cwv-health may not have run)' };
      }
      const data = readJSON(cwvFile);
      const latest = data.latest;
      if (!latest || !latest.timestamp) {
        return { name: 'CWV: performance', status: 'warn', message: 'No latest CWV run found' };
      }
      const age = hoursAgo(latest.timestamp);
      if (age > 336) { // 14 days — weekly check, allow 2 weeks
        return { name: 'CWV: performance', status: 'warn', message: `Last CWV check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-cwv-health workflow manually' };
      }
      const alerts = [];
      const m = latest.mobile || {};
      const d = latest.desktop || {};
      // CI runners are ~30-50% slower than real devices; use relaxed thresholds
      // to avoid false alarms from CI variance (e.g. TBT 759ms on a 750 threshold)
      if (m.lcp > 6000) alerts.push(`Mobile LCP ${(m.lcp / 1000).toFixed(1)}s`);
      if (m.cls > 0.15) alerts.push(`Mobile CLS ${m.cls.toFixed(3)}`);
      if (m.tbt > 1000) alerts.push(`Mobile TBT ${m.tbt.toFixed(0)}ms`);
      if (d.lcp > 3000) alerts.push(`Desktop LCP ${(d.lcp / 1000).toFixed(1)}s`);
      if (d.cls > 0.1) alerts.push(`Desktop CLS ${d.cls.toFixed(3)}`);
      if (d.tbt > 400) alerts.push(`Desktop TBT ${d.tbt.toFixed(0)}ms`);

      if (alerts.length > 0) {
        return { name: 'CWV: performance', status: 'warn', message: `Threshold violations: ${alerts.join(', ')}`, hint: 'Check Lighthouse results in data/audit/cwv-results.json' };
      }
      return { name: 'CWV: performance', status: 'pass', message: `All metrics within thresholds (${formatAge(age)} ago)` };
    }),
  ];
}

// --- Category G: SEO Health ---

function checkSEO() {
  return [
    runCheck('SEO: health', () => {
      const seoFile = path.join(AUDIT_DIR, 'seo-health.json');
      if (!fs.existsSync(seoFile)) {
        return { name: 'SEO: health', status: 'warn', message: 'No SEO data (check-seo-health may not have run)' };
      }
      const data = readJSON(seoFile);
      const age = (data.timestamp || data.lastChecked) ? hoursAgo(data.timestamp || data.lastChecked) : Infinity;
      if (age > 336) { // 14 days
        return { name: 'SEO: health', status: 'warn', message: `Last SEO check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-seo-health workflow manually' };
      }
      // Check for anomalies flagged by the SEO health script.
      // Anomaly objects are { type, severity, message } — there is NO `metric`
      // field, so the alert MUST render `message` (or `type`), not `a.metric`,
      // or every SEO alert reads "N critical SEO anomalies: , " with blank
      // descriptions and is unactionable (the state this digest sat in).
      const describe = (a) => a.message || a.type || 'unknown';
      if (data.anomalies && data.anomalies.length > 0) {
        const critical = data.anomalies.filter(a => a.severity === 'error');
        if (critical.length > 0) {
          return { name: 'SEO: health', status: 'error', message: `${critical.length} critical SEO anomalies: ${critical.map(describe).join('; ')}`, hint: 'Check data/audit/seo-health.json for details' };
        }
        return { name: 'SEO: health', status: 'warn', message: `${data.anomalies.length} SEO warning(s): ${data.anomalies.map(describe).join('; ')}`, hint: 'Check data/audit/seo-health.json for details' };
      }
      // Check index coverage — only warn if <50% (sample is 50 URLs from 700+ pages,
      // skewed toward historical shows Google deprioritizes)
      if (data.indexCoverage) {
        const { indexed, total } = data.indexCoverage;
        if (total > 0 && indexed / total < 0.5) {
          return { name: 'SEO: health', status: 'warn', message: `${((indexed / total) * 100).toFixed(0)}% indexed (${indexed}/${total})` };
        }
      }
      return { name: 'SEO: health', status: 'pass', message: `Healthy (${formatAge(age)} ago)` };
    }),
  ];
}

// --- Category H: Cron Health (via GitHub API) ---

function checkCronHealth() {
  // Uses `gh` CLI to check last run of critical workflows
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Cron: health', status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }

  // Keep in sync with .github/workflows/check-cron-health.yml CRITICAL_CRONS.
  // User-facing data refresh workflows were added 2026-04-14 so that their
  // most-recent-run failures surface in the daily digest with fix-now
  // urgency (playbook entry: `^Cron failed:`). Owner reads the email, not
  // the Discord channel the workflow's native notify-failure targets.
  const CRITICAL_CRONS = [
    { workflow: 'update-show-status.yml', maxHours: 36, name: 'Update Show Status' },
    { workflow: 'rebuild-reviews.yml', maxHours: 36, name: 'Rebuild Reviews' },
    { workflow: 'collect-review-texts.yml', maxHours: 36, name: 'Collect Review Texts' },
    { workflow: 'llm-ensemble-score.yml', maxHours: 48, name: 'LLM Ensemble Score' },
    { workflow: 'test.yml', maxHours: 48, name: 'Test Suite' },
    { workflow: 'opening-night-broadcast.yml', maxHours: 36, name: 'Opening Night Broadcast' },
    { workflow: 'update-lottery-rush.yml', maxHours: 192, name: 'Update Lottery/Rush' },
    { workflow: 'weekly-grosses.yml', maxHours: 192, name: 'Weekly Grosses' },
    { workflow: 'update-show-score.yml', maxHours: 192, name: 'Update Show Score' },
    { workflow: 'update-mezzanine.yml', maxHours: 192, name: 'Update Mezzanine' },
    { workflow: 'update-cast-changes.yml', maxHours: 120, name: 'Update Cast Changes' },
    { workflow: 'weekly-nyt-critics-picks.yml', maxHours: 72, name: 'NYT Critics Picks' },
    { workflow: 'weekly-video-reviews.yml', maxHours: 192, name: 'Weekly Video Reviews' },
    { workflow: 'update-social-pulse.yml', maxHours: 192, name: 'Update Social Pulse' },
    // 6-hourly; 24h = four missed runs. If this goes dark the evidence layer
    // (roundup-anchored selection + missing-show candidates) silently stops.
    { workflow: 'audit-reverse-discovery.yml', maxHours: 24, name: 'Reverse Discovery' },
  ];

  return CRITICAL_CRONS.map(({ workflow, maxHours, name }) =>
    runCheck(`Cron: ${name}`, () => {
      try {
        // limit=5, not 1: on high-churn workflows the newest run is routinely a
        // cancel-cascade casualty (a data commit lands, GitHub cancels the
        // in-flight run in favour of the newer one). Reading only the head run
        // reported "Cron failed: cancelled" while the cron was in fact doing its
        // job on the very next run — see task #80, ~75% of Test Suite runs on main
        // cancel this way. Same single API call, five records.
        // Cached (shared across every concurrently-dispatched session on this
        // Mac, see scripts/lib/gh-api-cache.js): 15 entries in this array is
        // 15 gh calls PER health-check.js run, and this runs on every
        // /ship-check + /wrap-up across ~dozens of dispatches/day.
        const result = cachedShell(
          `cron:${workflow}`,
          `gh run list --workflow="${workflow}" --limit=5 --json createdAt,conclusion`
        );
        const runs = result ? JSON.parse(result) : [];
        if (!runs.length) {
          return { name: `Cron: ${name}`, status: 'warn', message: 'No runs found' };
        }
        const run = runs[0];
        const age = hoursAgo(run.createdAt);
        if (age > maxHours) {
          return { name: `Cron: ${name}`, status: 'error', message: `Last run ${formatAge(age)} ago (max ${maxHours}h). Conclusion: ${run.conclusion}`, hint: 'Check Actions tab — workflow may be disabled' };
        }
        if (run.conclusion === 'success') {
          return { name: `Cron: ${name}`, status: 'pass', message: `${formatAge(age)} ago, success` };
        }
        if (!run.conclusion) {
          // Still running/queued — limit=1 with no status filter can return an
          // in-flight run. Not evidence of a problem, so stays at baseline
          // urgency rather than routing to the fix-now `Cron failed:` name.
          return { name: `Cron: ${name}`, status: 'warn', message: `Last run still running (started ${formatAge(age)} ago)` };
        }
        // The head run is inconclusive. Before calling that a failure, check
        // whether a RECENT run actually succeeded: a cancelled head run with a
        // green run still inside the freshness window means the cron is working
        // and the newest attempt was just superseded. That is TRUE STATE, not an
        // unfixed failure, and reporting it as one produced permanent digest
        // warnings for Rebuild Reviews and Test Suite that no fix could clear.
        const recentSuccess = runs.find(r => r.conclusion === 'success' && hoursAgo(r.createdAt) <= maxHours);
        if (recentSuccess) {
          return {
            name: `Cron: ${name}`,
            status: 'pass',
            message: `${formatAge(hoursAgo(recentSuccess.createdAt))} ago, success (newest run ${run.conclusion} — superseded, not a failure)`,
          };
        }
        // No successful run inside the window: failure / cancelled / skipped /
        // timed_out / action_required / neutral / stale all mean the cron has not
        // demonstrably done its job. Emit under a distinct name so the playbook
        // routes to fix-now urgency (prominent in digest), separate from the
        // baseline `Cron: X` staleness checks which stay at low urgency.
        // Previously only 'failure' routed here — cancelled/timed_out runs
        // silently read as 'pass' (ship-check adversarial finding on #367
        // surfaced the same bug in checkSecretsHealth(); same fix applied here).
        return { name: `Cron failed: ${name}`, status: 'warn', message: `Last run inconclusive: ${run.conclusion} (${formatAge(age)} ago), no success in ${maxHours}h` };
      } catch (err) {
        return { name: `Cron: ${name}`, status: 'warn', message: `gh CLI failed: ${err.message.substring(0, 80)}` };
      }
    })
  );
}

// --- Category I: Secrets Health ---

function checkSecretsHealth() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Secrets: health', status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }

  return [
    runCheck('Secrets: health', () => {
      try {
        // limit=5 for the same reason as checkCriticalCrons(): a cancelled head
        // run with a green run still inside the window is a supersession, not a
        // failure. #367 noted the two checks share this logic and must move
        // together — they drifted again, so keep them in step.
        const result = cachedShell(
          'cron:check-secrets-health.yml',
          `gh run list --workflow="check-secrets-health.yml" --limit=5 --json createdAt,conclusion`
        );
        const runs = result ? JSON.parse(result) : [];
        if (!runs.length) {
          return { name: 'Secrets: health', status: 'warn', message: 'No secrets check runs found' };
        }
        const run = runs[0];
        const age = hoursAgo(run.createdAt);
        if (age > 336) { // 14 days — weekly check
          return { name: 'Secrets: health', status: 'warn', message: `Last check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-secrets-health workflow manually' };
        }
        if (run.conclusion === 'success') {
          return { name: 'Secrets: health', status: 'pass', message: `Last check passed (${formatAge(age)} ago)` };
        }
        if (run.conclusion === 'failure') {
          return { name: 'Secrets: health', status: 'error', message: `Last check FAILED (${formatAge(age)} ago)`, hint: 'Check check-secrets-health workflow logs' };
        }
        if (!run.conclusion) {
          // Still running/queued — limit=1 with no status filter can return an
          // in-flight run (conclusion is null until it completes). Not a pass:
          // a stuck run would otherwise silently mask its eventual result.
          return { name: 'Secrets: health', status: 'warn', message: `Last check still running (started ${formatAge(age)} ago)`, hint: 'Check check-secrets-health workflow run status' };
        }
        // Head run inconclusive: a green run still inside the 14d window means the
        // check did verify the secrets and the newest attempt was superseded.
        const recentPass = runs.find(r => r.conclusion === 'success' && hoursAgo(r.createdAt) <= 336);
        if (recentPass) {
          return { name: 'Secrets: health', status: 'pass', message: `Last check passed (${formatAge(hoursAgo(recentPass.createdAt))} ago; newest run ${run.conclusion} — superseded, not a failure)` };
        }
        // cancelled / skipped / timed_out / action_required / neutral / stale with no
        // pass inside the window — inconclusive, not a verified pass (ship-check
        // adversarial finding, #367).
        return { name: 'Secrets: health', status: 'warn', message: `Last check inconclusive: ${run.conclusion} (${formatAge(age)} ago), no pass in 14d`, hint: 'Check check-secrets-health workflow logs' };
      } catch (err) {
        return { name: 'Secrets: health', status: 'warn', message: `gh CLI failed: ${err.message.substring(0, 80)}` };
      }
    }),
  ];
}

// --- Category I3: Alert Router Deadman ---
//
// Independent detector for the router-silently-broken failure class
// (2026-07-24 npm-ci postmortem, Notion card #374: notion-brain.js crashed on
// a missing @notionhq/client, and every disposition='auto' dispatch failed
// silently for days because the ledger never records failed attempts — only
// successes — so nothing looked wrong to anything reading the ledger alone).
//
// Reads the trailing-7-day dispatch ATTEMPT log (readDispatchAttempts —
// scripts/lib/owner-alert-router.js records every disposition='auto' call,
// success AND failure) and flags when attempts happened but NONE succeeded.
// This does not depend on the ledger, and does not depend on the E2E canary
// (scripts/e2e-canary-alert-chain.js) ever having run — it fires even if the
// canary itself is broken or was skipped that day.
//
// isCI gates the self-page (added after a local run of the sibling canary
// script paged the owner at midnight, 2026-07-24 — this check has the exact
// same live-side-effect shape and runs unconditionally as part of building
// `allResults`, BEFORE main()'s own `if (!isCI) return` early-exit, so
// without this guard a local `node scripts/health-check.js` with a failed
// attempts-log history would ALSO email the owner for real).
async function checkAlertRouterDeadman(isCI) {
  // readDispatchAttempts returns oldest→newest by ts, so the last element is
  // always the most recent attempt regardless of file/write order.
  const attempts = readDispatchAttempts({ days: 7 });
  if (attempts.length === 0) {
    return [{ name: 'Alert Router: dispatch deadman', status: 'pass', message: 'No auto-dispatch attempts in the trailing 7d (nothing to check)' }];
  }

  const succeeded = attempts.filter(a => a.ok).length;
  const mostRecent = attempts[attempts.length - 1];
  // Ship-check finding: gating on "any success in the 7d window" lets one
  // stale success mask an outage that started right after it — the exact
  // failure class this check exists to catch. Gate on the MOST RECENT
  // attempt instead: if it succeeded, the chain is healthy right now
  // regardless of history; if it failed, that's live broken state even if
  // older attempts this week succeeded.
  if (mostRecent.ok) {
    // "succeeded" here means the LAUNCH succeeded — not that the session did any
    // work. Saying otherwise is what let a fully dead fleet read 42/42 green for
    // 13 days (2026-08-10). Whether jobs actually fixed anything is the separate
    // "Autofix: jobs actually succeeding" row, which reads outcomes.
    return [{ name: 'Alert Router: dispatch deadman', status: 'pass', message: `${succeeded}/${attempts.length} auto-dispatch attempts LAUNCHED ok in the last 7d (launch only — see "Autofix: jobs actually succeeding" for whether they fixed anything)` }];
  }

  // Most recent attempt failed. Surface the most recent REAL error
  // verbatim — this exact spot is where the npm-ci incident got
  // misdiagnosed as a NOTION_API_KEY problem by a hand-written guess instead
  // of the logged error.
  const message = `Most recent auto-dispatch attempt failed (${succeeded}/${attempts.length} succeeded in the last 7d) — same failure class as the 2026-07-24 npm-ci incident. Last error: ${mostRecent.error || '(none captured)'}`;

  // Self-page via disposition='human' directly from here — that path calls
  // sendAlert() (Resend) and never shells out to notion-brain.js, so it
  // survives even though the exact thing we just detected as broken is that
  // shell-out. Don't rely on the generic humanAction dispatch loop below,
  // which routes through disposition='auto' (the same broken path).
  // isCI-gated: never page from a local/dev run (see function header comment).
  if (isCI) {
    try {
      await routeAlert({
        conditionKey: 'alert-router:deadman',
        title: 'Alert Router: auto-dispatch has been silently failing for 7 days',
        description: message,
        severity: 'critical',
        disposition: 'human',
        cooldownHours: 24,
      });
    } catch (err) {
      console.error(`[Deadman] failed to send direct human alert: ${err.message}`);
    }
  } else {
    console.error('[Deadman] DEV RUN — suppressing the owner-facing disposition=human alert (no GITHUB_ACTIONS/CI env). In real CI this would page the owner.');
  }

  return [{
    name: 'Alert Router: dispatch deadman',
    status: 'error',
    message,
    hint: 'Check the notion-brain.js shell-out first (workflow env/dependency gap, e.g. missing npm ci) before assuming NOTION_API_KEY — read the actual last error above, not a guess.',
  }];
}

// --- Auto-fix effectiveness (2026-08-10 incident) ---
//
// The owner received a near-identical morning digest 13 days running. Cause: the
// local `claude` CLI was logged out, so every headless auto-fix job started,
// emitted zero bytes, and hit its own timeout — leaving cards `in_progress`
// forever and the same ~31 issues re-reporting each morning.
//
// "Alert Router: dispatch deadman" did NOT catch it: it counts dispatch ATTEMPTS,
// so it read `42/42 auto-dispatch attempts succeeded` while the true fix rate was
// zero. This row reads the OUTCOMES the ledger already records (card-pass /
// card-fail) and is the difference between noticing on day 2 and on day 13.
function checkAutofixEffectiveness() {
  const name = 'Autofix: jobs actually succeeding';
  const file = path.join(__dirname, '..', 'data', 'audit', 'digest-autofix-ledger.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // WARN, never ERROR. The ledger is untracked, so in CI it is always absent:
      // erroring here would paint the digest red every single morning forever —
      // including after the loop is fully healthy — and burn one of the three
      // daily auto-dispatch slots on a card no CI session can fix. That is the
      // failure this row exists to prevent, so it must not commit it. Warn keeps
      // the blind spot visible without escalating; tracking the ledger is the
      // real fix (card "health digest is blind in CI — 6 untracked ledgers").
      return [{
        name,
        status: 'warn',
        message: 'Auto-fix health is not measurable here: data/audit/digest-autofix-ledger.jsonl is absent. '
          + 'It is untracked, so CI never sees it — this row cannot judge the loop from this environment.',
        hint: 'Track the ledger (or run this check on the dispatch host) so auto-fix success rate becomes visible where the digest is generated.',
      }];
    }
    // Fail loud: a check that cannot read its input must not report healthy —
    // that is the failure mode this whole row exists to end.
    return [{ name, status: 'warn', message: `Could not read the auto-fix ledger: ${err.message}` }];
  }

  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip unparseable line */ }
  }

  // No dispatchCount option: launches now come from this ledger's own
  // `auto-dispatch` rows (see autofix-effectiveness.js header for why the
  // alert-router coupling was removed).
  const r = assessAutofixEffectiveness(rows);
  return [{
    name,
    status: r.status,
    message: r.message,
    ...(r.status === 'error' ? {
      // NOT `claude auth status` / a bare `claude -p`: the fleet does not use the
      // CLI's stored login. claude-cli.js injects ANTHROPIC_API_KEY /
      // CLAUDE_CODE_OAUTH_TOKEN from .env into every spawned job (resolveAuthEnv
      // + strippedEnv), because under launchd process.env carries only the
      // plist's block. A bare probe from an interactive shell therefore reports
      // "Not logged in" even while the fleet is healthy — 2026-08-11: that false
      // reading was reported to the owner as a total outage, twice.
      hint: 'Read the newest log in ~/Library/Logs/bsc-jobs/ — empty apart from a TIMEOUT marker means the job produced nothing. Then confirm .env still carries ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude-cli.js forwards these; the CLI\'s own stored login is NOT what the fleet uses).',
    } : {}),
  }];
}

// --- Digest-autofix S6: daily canary + throughput (task #1225) ---
//
// checkAutofixEffectiveness above answers "of the jobs that reported back,
// how many succeeded" over a 7-day window. It cannot answer "did the pipeline
// dispatch anything AT ALL today" — the exact question that would have caught
// the 8/5-8/9 starvation (task #1184) on day 2 instead of day 5. These two
// rows close that gap: a live end-to-end canary (scripts/lib/autofix-canary.js)
// and a daily throughput rollup with an explicit zero-activity alarm. Both
// ledgers are gitignored/per-machine (same as digest-autofix-ledger.jsonl
// above) — ENOENT reads as `null` (never `[]`) so the pure functions can tell
// "absent here" from "present and empty", and both follow the same
// warn-never-error-never-silent-pass rule task #1221 exists to enforce.
function readJsonlLedgerOrNull(absPath) {
  if (!fs.existsSync(absPath)) return null;
  let raw;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function checkAutofixCanary() {
  const { assessCanaryRow } = require('./lib/autofix-canary.js');
  const dispatchLedger = require('./lib/dispatch-ledger.js');
  const canaryLedgerEntries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'autofix-canary-ledger.jsonl'));
  let dispatchLedgerEntries = [];
  try { dispatchLedgerEntries = dispatchLedger.readEntries(); } catch { /* stage folding degrades to card-filed-only */ }
  return [assessCanaryRow({ canaryLedgerEntries, dispatchLedgerEntries })];
}

function checkAutofixThroughput() {
  const { assessThroughputRow } = require('./lib/autofix-canary.js');
  const digestLedgerEntries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'digest-autofix-ledger.jsonl'));
  const backlogLedgerEntries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'backlog-drain-ledger.jsonl'));
  return [assessThroughputRow({ digestLedgerEntries, backlogLedgerEntries })];
}

// --- Push-retry deadman (task #394) ---
//
// scripts/lib/push-with-retry.sh appends a JSONL record to
// data/audit/push-retry-failures.jsonl whenever it abandons a push — either a
// no-op-rebase abort or full retry exhaustion. This surfaces that telemetry so a
// silent-forever push failure (the exact class that stranded the alert-ledger and
// killed cooldown/dedup across CI) becomes a visible digest row instead of a
// swallowed `|| echo ::warning`. Non-paging: it's a digest signal, not a critical
// self-page — the root-cause fix (explicit-destination fetch) is what actually
// prevents the failure, and a persisted failure record already means SOME run
// landed a later commit carrying the log, so the state is recoverable.
//
// PERSISTENCE CAVEAT: when a failed push is the ONLY write in a CI job, the log
// dies with the runner and never reaches origin — so this row is a best-effort
// backstop (it reliably catches local runs and jobs that land a later push), not a
// guarantee. The definitive protection remains the fix + the ::error:: annotation.
function checkPushRetryDeadman() {
  const logPath = path.join(__dirname, '..', 'data', 'audit', 'push-retry-failures.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [{ name: 'Push-retry deadman', status: 'pass', message: 'No push-retry failures recorded (log absent)' }];
  }

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    const ts = Date.parse(rec.ts);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    recent.push(rec);
  }

  if (recent.length === 0) {
    return [{ name: 'Push-retry deadman', status: 'pass', message: 'No push-retry failures in the trailing 7d' }];
  }

  const noops = recent.filter((r) => String(r.reason || '').startsWith('noop-rebase'));
  const branches = [...new Set(recent.map((r) => `${r.remote || '?'}:${r.branch || '?'}`))];
  // A no-op-rebase record is the #394 signature and the more serious signal (a
  // stale-ref regression); 3+ exhaustions in a week is also worth an error row.
  const status = noops.length > 0 || recent.length >= 3 ? 'error' : 'warn';
  const message =
    `${recent.length} push-retry failure(s) in the last 7d` +
    (noops.length > 0 ? ` including ${noops.length} NO-OP-rebase abort(s) (task-#394 stale-ref signature)` : '') +
    ` across ${branches.join(', ')}. Most recent reason: ${recent[recent.length - 1].reason || '?'}.`;

  return [{
    name: 'Push-retry deadman',
    status,
    message,
    hint: 'A no-op-rebase abort means refs/remotes/origin/<branch> is stale after fetch (SHA-pinned checkout refspec) — verify scripts/lib/push-with-retry.sh still fetches with an explicit +refs/heads/X:refs/remotes/origin/X destination. Exhaustion means the remote genuinely could not be integrated.',
  }];
}

// --- Category I3: Infra-review gate telemetry (task #1095) ---
//
// The #1079 gate (~/.claude/hooks/infra-plan-review-gate.sh,
// scripts/lib/infra-review-scope.js) writes every warn/block to
// data/audit/infra-review-gate.jsonl — gitignored, per-machine, read by
// nothing until now. A session that ran a real /plan-review and one that
// typed "NO-PLAN-REVIEW: whatever" both look like silence from the owner's
// side. Card #672 named the honest observable: the ratio of real
// pre-implementation reviews (phase:'plan' verdicts in
// .claude/review-verdicts.jsonl) to bypasses. Pure counting logic lives in
// scripts/lib/infra-review-digest.js (tested by
// scripts/tests/infra-review-digest.test.mjs) — this just reads the two
// ledgers and hands them over.

function readJsonlBestEffort(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* tolerate partial line */ }
  }
  return out;
}

// Both ledgers are written by ~/.claude/hooks/infra-plan-review-gate.sh /
// scripts/lib/review-gate.mjs at the MAIN checkout root — resolved via
// `git rev-parse --git-common-dir`, not the invoking script's own directory,
// specifically so a worktree session's writes land somewhere every other
// worktree (and this check) can see (infra-review-scope.js header, and
// review-gate.mjs's canonicalRoot()). This file is __dirname-relative by
// default (matching every other check here), which resolves to the WRONG
// directory when health-check.js itself runs from inside a worktree — the
// overwhelmingly common case per this repo's own worktree-first mandate.
// Reading via __dirname alone would make this check see nothing even on the
// same machine, in the same run, that just wrote real events.
function infraReviewLedgerRoot() {
  try {
    const common = execSync('git rev-parse --git-common-dir', { cwd: __dirname, encoding: 'utf8' }).trim();
    if (!common) return path.join(__dirname, '..');
    // `common` is already relative to __dirname (git was invoked with
    // cwd: __dirname) — joining it against __dirname alone resolves it
    // correctly, matching review-gate.mjs's canonicalRoot(). An earlier
    // version prepended an extra '..' here, which double-counted the
    // "go up one level" already baked into a relative --git-common-dir
    // result (e.g. "../.git") and landed one directory ABOVE the actual
    // repo root for any plain (non-worktree) checkout — silently wrong
    // only for the primary Mac Studio use case, since worktree common-dir
    // happens to come back absolute and skip this branch entirely
    // (caught by ship-check's adversarial review, task #1095).
    const abs = path.isAbsolute(common) ? common : path.join(__dirname, common);
    return path.dirname(abs);
  } catch {
    return path.join(__dirname, '..');
  }
}

function checkInfraReviewGate() {
  const ledgerRoot = infraReviewLedgerRoot();
  const gatePath = path.join(ledgerRoot, 'data', 'audit', 'infra-review-gate.jsonl');
  const verdictsPath = path.join(ledgerRoot, '.claude', 'review-verdicts.jsonl');
  // Both ledgers are gitignored, per-machine files the local
  // infra-plan-review-gate.sh hook writes only on a dev machine — a fresh CI
  // checkout will never have them. Reporting the same "no edits observed"
  // pass message in that case would be indistinguishable from a genuinely
  // clean week: exactly the vacuous-gate failure class (task #1075, #1063-69)
  // this file elsewhere insists on failing loud for. Say plainly that this
  // environment can't see the telemetry instead of silently passing.
  if (!fs.existsSync(gatePath) && !fs.existsSync(verdictsPath)) {
    return [{
      name: 'Infra-review: gate telemetry',
      status: 'warn',
      message: 'No local infra-review telemetry visible from this environment — data/audit/infra-review-gate.jsonl and .claude/review-verdicts.jsonl are gitignored, per-machine files the #1079 hook writes only where it runs. This check cannot confirm the plan-review gate is being used or bypassed from here.',
      hint: 'Run `node scripts/health-check.js` on the machine where the hook actually fires to see real counts. A CI-visible rollup (so the scheduled digest sees this too) is tracked as a follow-up.',
    }];
  }
  const { computeInfraReviewDigest } = require('./lib/infra-review-digest.js');
  const gateEvents = readJsonlBestEffort(gatePath);
  const planVerdicts = readJsonlBestEffort(verdictsPath);
  return [runCheck('Infra-review: gate telemetry', () => computeInfraReviewDigest({
    gateEvents, planVerdicts, now: Date.now(),
  }))];
}

// --- Category: Dispatch outcomes (did dispatched work actually land?) ---
//
// scripts/audit-dispatch-outcomes.js (task #1101) already classifies every
// dispatch as landed/in-flight/abandoned by cross-referencing
// data/audit/dispatch-ledger.jsonl against the task store, but nothing ran
// it — its first real run found 37 abandoned dispatches that had gone unseen
// for up to 14 days (task #1106). This wires its pure decision function
// (scripts/lib/dispatch-outcome-digest.js) into the daily digest.
//
// dispatch-ledger.jsonl is gitignored/per-machine, same as the infra-review
// ledger above — a fresh CI checkout won't have it. Say so plainly instead of
// a silent pass (#1075 vacuous-gate class).
//
// previousAbandonedCount is tracked in its own small state file rather than
// folded into the shared HISTORY_FILE: history.results (below, ~L3546) is
// deliberately narrowed to {name,status,message} for every check to avoid
// bloating health-check-history.json, so extending it would mean widening
// that shared shape for one check. A dedicated per-check state file already
// has precedent here (tryAutoFix()'s data/audit/triage/autofix-*.json
// attempt counters) — this follows the same pattern.
const DISPATCH_OUTCOME_STATE_FILE = path.join(AUDIT_DIR, 'dispatch-outcome-digest-state.json');

function checkDispatchOutcomes(dryRun) {
  const ledgerPath = path.join(AUDIT_DIR, 'dispatch-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    return [{
      name: 'Dispatch outcomes: abandoned',
      status: 'warn',
      message: 'No local dispatch-ledger.jsonl visible from this environment — data/audit/dispatch-ledger.jsonl is gitignored, per-machine, written only where dispatches actually launch. This check cannot confirm dispatch outcomes from here.',
      hint: 'Run `node scripts/health-check.js` (or `node scripts/audit-dispatch-outcomes.js`) on the machine where dispatches launch to see real counts.',
    }];
  }

  return [runCheck('Dispatch outcomes: abandoned', () => {
    const { computeDispatchOutcomeDigest } = require('./lib/dispatch-outcome-digest.js');
    const { classifyDispatches, OUTCOMES } = require('./lib/dispatch-outcome.js');
    const { loadTasksUnioned } = require('./audit-dispatch-outcomes.js');

    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const dispatchLedgerEntries = raw.trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    // loadTasksUnioned() throws loud on an empty/unreadable task store — do
    // NOT wrap this in a try/catch that defaults to an empty Map. runCheck()
    // (the caller) turns an uncaught throw into a visible 'error' status row,
    // which is the point: a dead task store must surface as broken, not as a
    // quiet "0 abandoned" pass (#1063/#1069 vacuous-gate class).
    const tasksById = loadTasksUnioned();

    // cmux-workspaces.js is the shared, tested cmux-liveness abstraction
    // (also used by the #1102 dispatch watchdog) — reuse it rather than
    // re-parsing `cmux list-workspaces` a second way.
    // An empty result is treated the SAME as cmux being unavailable (ship-check
    // finding, task #1106): `listWorkspaces()` returns `[]` on a cmux daemon
    // hiccup or malformed output, not a throw — trusting an empty Set as
    // ground truth would flip EVERY in-flight dispatch with a workspaceRef to
    // ABANDONED in one shot (dispatch-outcome.js's workspaceGone check is
    // `!live.has(ref)`, true for everything when live is empty). "Never
    // guess" already governs the ledger-side helper this mirrors
    // (audit-dispatch-outcomes.js's own liveWorkspaceRefs()) — apply the same
    // rule here: only trust cmux when it reports at least one workspace.
    let liveWorkspaceRefs;
    try {
      const { cmuxAvailable, listWorkspaces } = require('./lib/cmux-workspaces.js');
      if (cmuxAvailable()) {
        const refs = listWorkspaces().map((w) => w.ref);
        if (refs.length > 0) liveWorkspaceRefs = new Set(refs);
      }
    } catch { /* cmux unavailable — classifyDispatches falls back to ledger-only */ }

    let previousAbandonedCount = null;
    try {
      if (fs.existsSync(DISPATCH_OUTCOME_STATE_FILE)) {
        const prev = readJSON(DISPATCH_OUTCOME_STATE_FILE);
        previousAbandonedCount = typeof prev.abandonedCount === 'number' ? prev.abandonedCount : null;
      }
    } catch { /* corrupt state file — treat as no history, don't fail the check over it */ }

    const row = computeDispatchOutcomeDigest({
      dispatchLedgerEntries, tasksById, liveWorkspaceRefs, previousAbandonedCount,
    });

    // The state file tracks the TRUE current count, not "count as of the
    // last alert" — recompute it directly rather than relying on `row`,
    // which is null both when there are 0 abandoned and when the count is
    // unchanged from last run.
    const currentAbandonedCount = classifyDispatches(
      dispatchLedgerEntries, tasksById, liveWorkspaceRefs ? { liveWorkspaceRefs } : {}
    ).filter((r) => r.outcome === OUTCOMES.ABANDONED).length;
    // dryRun (health-row-probe.js's live verification probe): compute the row
    // exactly as normal but skip the trend-cache write — a probe run must never
    // perturb the state a REAL health-check.js run compares "unchanged since
    // last run" against, or it corrupts tomorrow's real digest message.
    if (!dryRun) {
      try {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        fs.writeFileSync(DISPATCH_OUTCOME_STATE_FILE, JSON.stringify({
          abandonedCount: currentAbandonedCount, updatedAt: new Date().toISOString(),
        }, null, 2) + '\n');
      } catch { /* best-effort persistence — a failed write here shouldn't fail the check */ }
    }

    if (row) return row;
    // currentAbandonedCount > 0 but unchanged from last run still counts as
    // 'warn', not 'pass' — an unresolved backlog must not silently drop out
    // of the digest's pass/warn/error tally just because it stopped
    // generating a fresh alert (the vacuous-pass class this whole check
    // exists to avoid). Only a genuinely zero count is a real pass.
    return currentAbandonedCount === 0
      ? { name: 'Dispatch outcomes: abandoned', status: 'pass', message: 'No abandoned dispatches' }
      : { name: 'Dispatch outcomes: abandoned', status: 'warn', message: `${currentAbandonedCount} abandoned dispatch(es), unchanged since last run — see \`node scripts/audit-dispatch-outcomes.js\`` };
  })];
}

// --- Category I1b: Dispatch health (do dispatched sessions actually START?) ---
//
// checkDispatchOutcomes above asks whether dispatched work LANDED. This asks
// the prior question: did the session ever start at all? Card #1199 — roughly
// one bsc-next launch in five creates its cmux workspace, never renders a
// terminal surface, and so never runs the injected command. The retry layer
// recovers the WORK, so each session sees only its own 1-3 failures, retries,
// succeeds, and truthfully reports success; nothing aggregated the ledger, so
// a chronic ~20% rate ran unseen for a week and several "fixes" were judged
// green by a single clean dispatch. Only the RATE over many launches can tell
// whether a cause fix worked, which is what this row is for.
//
// Same gitignored/per-machine caveat as checkDispatchOutcomes — say so plainly
// rather than passing on missing input (#1075 vacuous-gate class).

function checkDispatchHealth() {
  const ledgerPath = path.join(AUDIT_DIR, 'dispatch-ledger.jsonl');
  const { CHECK_NAME } = require('./lib/dispatch-health.js');
  if (!fs.existsSync(ledgerPath)) {
    return [{
      name: CHECK_NAME,
      status: 'warn',
      message: 'No local dispatch-ledger.jsonl visible from this environment — data/audit/dispatch-ledger.jsonl is gitignored, per-machine, written only where dispatches actually launch. The dead-launch rate cannot be measured from here.',
      hint: 'Run `node scripts/audit-dispatch-dead-rate.js` on the machine where dispatches launch to see the real rate.',
    }];
  }

  return [runCheck(CHECK_NAME, () => {
    const { computeDispatchHealthDigest } = require('./lib/dispatch-health.js');
    const entries = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    // No previous-value suppression on purpose (contrast checkDispatchOutcomes'
    // DISPATCH_OUTCOME_STATE_FILE): a static abandoned COUNT is stale news, but
    // a RATE above the floor is a live defect every day it holds, and
    // "unchanged since yesterday" silence is exactly the invisibility #1199
    // exists to end. Repeat-day email noise is already handled downstream by
    // owner-alert-router's conditionKey, which files one card per OPEN
    // incident rather than one per run.
    const { name, status, message, hint } = computeDispatchHealthDigest({
      entries, nowMs: Date.now(),
    });
    return hint ? { name, status, message, hint } : { name, status, message };
  })];
}

// --- Category I2: Deploy freshness (content-aware gate watchdog) ---
//
// The should-deploy gate (scripts/lib/should-deploy-gate.js) skips scheduled
// deploys when nothing site-relevant changed, with a 6h staleness backstop.
// All existing alerting keys off run FAILURES — a gate stuck wrongly-closed
// produces green skip runs and zero deploys with no signal (plan-review
// pre-mortem, 2026-07-19). This check is the stuck-closed detector: the
// backstop guarantees a READY production deployment at least every ~6h
// (plus cron delay), so age >8h means the gate, the cron, or Vercel is broken.
// Uses check-prod-deploy.js (canonical READY-deployment query) — do not
// hand-roll another copy of the Vercel API call.

function checkDeployFreshness() {
  if (!process.env.VERCEL_TOKEN) {
    return [{ name: 'Deploy: production freshness', status: 'warn', message: 'Skipped — no VERCEL_TOKEN available' }];
  }
  return [runCheck('Deploy: production freshness', () => {
    let out;
    try {
      out = execSync('node scripts/check-prod-deploy.js --json', {
        encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // check-prod-deploy exits 2 on API/network failure — a transient Vercel
      // blip is not "prod is stale"; warn (visible in digest) instead of error
      // (subject-line escalation). A real freshness breach still errors below.
      return { name: 'Deploy: production freshness', status: 'warn', message: `Vercel API unreachable (${err.message.split('\n')[0].slice(0, 120)}) — freshness unknown this run` };
    }
    const dep = JSON.parse(out);
    const ageH = dep.ageSec / 3600;
    const msg = `Latest READY production deploy: ${dep.deployedSha ? dep.deployedSha.slice(0, 10) : 'unknown-sha'}, age ${ageH.toFixed(1)}h`;
    const hint = 'Gate stuck or cron dead? Check should-deploy runs (gh run list --workflow=vercel-deploy.yml), dispatch "Rebuild Reviews (Fast)", or set repo var DEPLOY_GATE_DISABLED=true';
    if (ageH > 12) return { name: 'Deploy: production freshness', status: 'error', message: msg + ' (>12h — 6h backstop is not firing)', hint };
    if (ageH > 8) return { name: 'Deploy: production freshness', status: 'warn', message: msg + ' (>8h — backstop late; GH cron delays can explain up to ~2h)', hint };
    return { name: 'Deploy: production freshness', status: 'pass', message: msg };
  })];
}

// --- Category: Stuck Work (silent Notion-brain states) ---
//
// Closes the blind spot found 2026-07-22 (alert-router card 3a4637c5): a P1
// card sat "Paused" with its build unshipped and NOTHING surfaced it — the
// nightly loop skips out-of-tier cards, the "stalling the loop" email only
// reports Auto-tagged cards, and session-start stale checks look at
// In-progress only. First live run found 41 paused P0/P1 + 50 in-progress
// cards idle >48h (oldest 89 days). Warn-level (visible in NEEDS YOUR
// ATTENTION) rather than error so a chronic backlog doesn't permanently
// red-flag the subject line.

async function checkStuckWork() {
  if (!process.env.NOTION_API_KEY) {
    return [{ name: 'Stuck work: brain cards', status: 'warn', message: 'Skipped — no NOTION_API_KEY available' }];
  }
  // Entire body is guarded: this is the only async check awaited bare in
  // main(), so an uncaught throw here would reject main() and kill the WHOLE
  // digest — the exact silent-failure class this check exists to catch.
  try {
    return await checkStuckWorkInner();
  } catch (err) {
    return [{ name: 'Stuck work: brain cards', status: 'warn', message: `Stuck-work check crashed — skipped this run (${err.message.slice(0, 160)})` }];
  }
}

async function checkStuckWorkInner() {
  const { classifyStuckCards, fetchBrainCards } = require('./lib/stuck-work');
  const cards = await fetchBrainCards(process.env.NOTION_API_KEY);
  if (cards.length === 0) {
    // ~120 cards sit in these states on a normal day. Zero means the status
    // names drifted (query filters match nothing) far more likely than a
    // genuinely empty brain — surface it instead of reporting a clean pass.
    return [{ name: 'Stuck work: brain cards', status: 'warn', message: 'Notion returned 0 Paused/In-progress cards — status names may have been renamed (check stuck-work.js filters)' }];
  }
  const { pausedCritical, pausedStale, pausedAwaitingRecheck, pausedParked, orphaned, invalidDates } = classifyStuckCards(cards, Date.now());
  const results = [];
  // Card names are free text typed into Notion and land in the HTML email —
  // escape them (first check to inject arbitrary text into the digest).
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Stamped-but-overdue and parked-past-the-window cards say why they count
  // as stuck (the nightly recheck / the owner should have acted by now).
  const fmt = (c) => `${esc(c.name.slice(0, 60))} (${Math.round(c.idleHours / 24)}d${c.stampOverdueDays != null ? `, stamp overdue ${c.stampOverdueDays}d` : ''}${c.parkedOverdueDays != null ? `, parked past 7d window by ${c.parkedOverdueDays}d` : ''})`;
  // Cards Paused-with-a-future-RECHECK-AFTER-stamp are parked by process rule
  // (/wrap-up deferred-effect fixes), not stuck — reported as info, never warn.
  // Same for tab-close-parked cards (bsc-prune `## Parked` marker) inside
  // their 7-day window. Both fold into the existing check's message: a new
  // check name would mint a new alert-router condition key (pass/warn/error
  // is the whole status vocabulary — there is no "info" status).
  const parkedNote = pausedParked.length > 0
    ? `${pausedParked.length} parked via tab-close, oldest ${new Date(pausedParked[0].parkedAtMs).toISOString().slice(0, 10)} — resume: node scripts/bsc-next.js --id ${pausedParked[0].parkedTaskId ?? 'N'} --force`
    : '';
  const awaitingNote = [
    pausedAwaitingRecheck.length > 0
      ? `${pausedAwaitingRecheck.length} awaiting recheck, earliest due ${new Date(pausedAwaitingRecheck[0].recheckAfterMs).toISOString().slice(0, 10)}`
      : '',
    parkedNote,
  ].filter(Boolean).join('; ');

  if (pausedCritical.length > 0) {
    results.push({
      // NOTE: this check name is a stable condition key — alert-router dedup
      // and Fix-button acceptance criteria reference `health-check:Stuck
      // work: paused P0/P1 cards` byte-for-byte. Never rename it.
      name: 'Stuck work: paused P0/P1 cards',
      status: 'warn',
      message: `${pausedCritical.length} P0/P1 card(s) sit Paused — invisible to the loop, the stalling email, and stale checks. Oldest: ${pausedCritical.slice(0, 3).map(fmt).join('; ')}${awaitingNote ? ` (${awaitingNote} — not counted)` : ''}`,
      hint: 'Triage: node scripts/notion-brain.js search --status Paused — un-pause + dispatch (bsc-next), resume a parked card (bsc-next --id N --force), close, or park with RECHECK-AFTER: YYYY-MM-DD',
    });
  } else {
    results.push({ name: 'Stuck work: paused P0/P1 cards', status: 'pass', message: `No stuck paused P0/P1 cards${awaitingNote ? ` (${awaitingNote})` : ''}` });
  }

  if (orphaned.length > 0) {
    results.push({
      name: 'Stuck work: orphaned in-progress cards',
      status: 'warn',
      message: `${orphaned.length} In-progress card(s) untouched >48h — owning session likely dead. Oldest: ${orphaned.slice(0, 3).map(fmt).join('; ')}`,
      hint: 'Triage: node scripts/notion-brain.js search --status "In progress" — re-dispatch, pause with a reason, or close',
    });
  } else {
    results.push({ name: 'Stuck work: orphaned in-progress cards', status: 'pass', message: 'No in-progress cards idle >48h' });
  }

  if (pausedStale.length > 0) {
    results.push({ name: 'Stuck work: paused P2/other cards', status: 'warn', message: `${pausedStale.length} lower-priority card(s) Paused >7d (FYI — close or re-queue when triaging)` });
  }
  if (invalidDates > 0) {
    results.push({ name: 'Stuck work: unparseable timestamps', status: 'warn', message: `${invalidDates} card(s) skipped — last_edited_time did not parse (they may be hiding stuck work)` });
  }
  return results;
}

// --- Category J: API Credits ---

function checkAPICredits() {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  const results = [];

  // No early return on a missing SB key — the SD/BD/BB checks below must
  // still run (each provider is monitored independently).
  if (!apiKey) {
    results.push({ name: 'Credits: ScrapingBee', status: 'warn', message: 'Skipped — no SCRAPINGBEE_API_KEY available' });
  } else results.push(runCheck('Credits: ScrapingBee', () => {
    try {
      const result = execSync(
        `curl -s "https://app.scrapingbee.com/api/v1/usage?api_key=${apiKey}"`,
        { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const usage = JSON.parse(result);
      const remaining = usage.max_api_credit - usage.used_api_credit;
      const pctUsed = Math.round((usage.used_api_credit / usage.max_api_credit) * 100);
      const pctRemaining = 100 - pctUsed;
      const remainingK = Math.round(remaining / 1000);

      // Project exhaustion date from burn rate
      let exhaustionMsg = '';
      if (usage.renewal_subscription_date && usage.used_api_credit > 0) {
        const renewalDate = new Date(usage.renewal_subscription_date);
        const renewalStr = renewalDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const daysUntilRenewal = Math.max(0, (renewalDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        // Estimate cycle length from renewal date (assume ~30 day cycles)
        const cycleStartEstimate = new Date(renewalDate);
        cycleStartEstimate.setDate(cycleStartEstimate.getDate() - 30);
        const daysIntoCycle = Math.max(1, (Date.now() - cycleStartEstimate.getTime()) / (1000 * 60 * 60 * 24));

        if (remaining <= 0) {
          exhaustionMsg = ` · EXHAUSTED · renews ${renewalStr}`;
        } else if (daysIntoCycle < 5) {
          // Too early in cycle for a reliable daily rate — denominator is too small
          exhaustionMsg = ` · renews ${renewalStr} (burn rate unavailable — <5 days into cycle)`;
        } else {
          const dailyBurnRate = Math.round(usage.used_api_credit / daysIntoCycle);
          const daysUntilExhaustion = remaining / dailyBurnRate;
          exhaustionMsg = ` · ${Math.round(dailyBurnRate / 1000)}k/day burn · `;
          if (daysUntilExhaustion < daysUntilRenewal) {
            exhaustionMsg += `exhausts in ~${Math.round(daysUntilExhaustion)}d (renews ${renewalStr})`;
          } else {
            exhaustionMsg += `lasts until renewal ${renewalStr}`;
          }
        }
      }

      if (pctRemaining <= 5) {
        if (remaining <= 0) {
          const ack = SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION;
          if (isScrapingBeeExhaustionAcknowledged()) {
            return { name: 'Credits: ScrapingBee', status: 'warn', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg} — acknowledged: ${ack.reason} [expires ${ack.expires}]` };
          }
        }
        return { name: 'Credits: ScrapingBee', status: 'error', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg}`, hint: 'Upgrade plan or reduce scraping.' };
      }
      if (pctRemaining <= 15) {
        return { name: 'Credits: ScrapingBee', status: 'warn', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg}`, hint: 'Monitor usage — may run out before renewal.' };
      }
      return { name: 'Credits: ScrapingBee', status: 'pass', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg}` };
    } catch (err) {
      return { name: 'Credits: ScrapingBee', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
    }
  }));

  // Scrapingdog — same burn-projection shape as SB. Added 2026-07-19 after the
  // SB-exhaustion incident revealed SD had ZERO balance monitoring: if SD runs
  // dry, every fetch silently falls back to BD/SB (the exact failure that
  // exhausted SB's plan). 'error' (not 'warn') on projected exhaustion so the
  // actionable-only email policy actually delivers it — EXCEPT while the
  // expiring scrapingdog-ack acknowledgment (task #418) covers a known,
  // non-imminent burn spike: that narrow case reports 'warn' with the ack
  // reason inline. Exhausted/near-dry/<3d-out balances always stay 'error'.
  const sdKey = process.env.SCRAPINGDOG_API_KEY;
  if (sdKey) {
    results.push(runCheck('Credits: ScrapingDog', () => {
      // Internal try/catch: a transient curl timeout / non-JSON response must
      // report 'warn', not 'error' — runCheck's catch would emit an emailing
      // 'error' for pure infra noise. 'error' is reserved for a successfully
      // parsed low/exhausted balance (same pattern as the SB check above).
      let acct;
      try {
        const result = execSync(
          `curl -s --max-time 10 "https://api.scrapingdog.com/account?api_key=${sdKey}"`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        acct = JSON.parse(result);
      } catch (err) {
        return { name: 'Credits: ScrapingDog', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
      }
      if (!acct.requestLimit) {
        return { name: 'Credits: ScrapingDog', status: 'warn', message: `Unexpected account response: ${JSON.stringify(acct).slice(0, 80)}` };
      }
      // Pure decision lives in scripts/lib/scrapingdog-ack.js (§15 extraction)
      // so the ack downgrade is unit-testable; this call site only fetches.
      const { status, message: msg } = evaluateScrapingdogCredits(acct);
      return { name: 'Credits: ScrapingDog', status, message: msg, hint: status !== 'pass' ? 'If SD runs dry, all traffic silently falls back to BD/SB. Upgrade plan or reduce scraping.' : undefined };
    }));
  } else {
    results.push({ name: 'Credits: ScrapingDog', status: 'warn', message: 'Skipped — no SCRAPINGDOG_API_KEY available' });
  }

  // Bright Data — month-to-date spend (serp + unlocker zones), balance shown
  // for context only. Alerting rationale in the comment inside the check.
  const bdToken = process.env.BRIGHTDATA_TOKEN;
  if (bdToken) {
    results.push(runCheck('Credits: Bright Data', () => {
      // Internal try/catch: infra failure → 'warn' (see ScrapingDog note above).
      let bal;
      try {
        const balRaw = execSync(
          `curl -s --max-time 10 -H "Authorization: Bearer ${bdToken}" "https://api.brightdata.com/customer/balance"`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        bal = JSON.parse(balRaw);
      } catch (err) {
        return { name: 'Credits: Bright Data', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
      }
      const monthStart = new Date();
      monthStart.setDate(1);
      const from = monthStart.toISOString().split('T')[0];
      const to = new Date().toISOString().split('T')[0];
      const zones = ['serp_api1', process.env.BRIGHTDATA_ZONE || 'web_unlocker2'];
      let monthCost = 0;
      for (const zone of [...new Set(zones)]) {
        try {
          const costRaw = execSync(
            `curl -s --max-time 10 -H "Authorization: Bearer ${bdToken}" "https://api.brightdata.com/zone/cost?zone=${zone}&from=${from}&to=${to}"`,
            { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();
          const cost = JSON.parse(costRaw);
          for (const cust of Object.values(cost)) {
            if (cust && cust.custom && typeof cust.custom.cost === 'number') monthCost += cust.custom.cost;
          }
        } catch { /* per-zone cost is best-effort */ }
      }
      // BD is pay-as-you-go with MONTHLY INVOICING (verified in dashboard
      // 2026-07-19: "All bills are paid", next invoice 1st of month). The
      // prepaid `balance` field is leftover credit, NOT a spending limit —
      // consumption accrues to the invoice and scraping does NOT hard-stop at
      // $0 balance. So low balance is normal and must not alert; the real
      // signal is month-to-date spend (runaway SERP demand). Baseline ~$225/mo
      // pace July 2026.
      const balance = typeof bal.balance === 'number' ? bal.balance : null;
      const pending = typeof bal.pending_costs === 'number' ? bal.pending_costs : 0;
      let msg = `balance $${balance !== null ? balance.toFixed(2) : '?'} · pending invoice $${pending.toFixed(2)} · month-to-date $${monthCost.toFixed(2)} (serp+unlocker)`;
      if (monthCost > 400) {
        return { name: 'Credits: Bright Data', status: 'error', message: msg, hint: 'BD spend above $400/mo pace — runaway SERP/unlocker demand, investigate now (cost report attributes by workflow).' };
      }
      if (monthCost > 250) {
        return { name: 'Credits: Bright Data', status: 'warn', message: msg, hint: 'BD spend above $250/mo pace — check SERP demand.' };
      }
      return { name: 'Credits: Bright Data', status: 'pass', message: msg };
    }));
  }

  // Browserbase — usage trend only (minutes are lifetime-cumulative; small volume).
  const bbKey = process.env.BROWSERBASE_API_KEY;
  const bbProject = process.env.BROWSERBASE_PROJECT_ID;
  if (bbKey && bbProject) {
    results.push(runCheck('Credits: Browserbase', () => {
      let usage;
      try {
        const raw = execSync(
          `curl -s --max-time 10 -H "X-BB-API-Key: ${bbKey}" "https://api.browserbase.com/v1/projects/${bbProject}/usage"`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        usage = JSON.parse(raw);
      } catch (err) {
        return { name: 'Credits: Browserbase', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
      }
      if (typeof usage.browserMinutes !== 'number') {
        return { name: 'Credits: Browserbase', status: 'warn', message: `Unexpected usage response: ${JSON.stringify(usage).slice(0, 80)}` };
      }
      return { name: 'Credits: Browserbase', status: 'pass', message: `${usage.browserMinutes} browser minutes used (cumulative)` };
    }));
  }

  return results;
}

// --- Category K: Workflow Runs (last 24h summary via GitHub API) ---

async function getWorkflowRunSummary() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true };
  }

  // Rate-limit headroom check FIRST (the /rate_limit endpoint itself is free
  // — see scripts/lib/gh-api-cache.js). This call alone can spend up to 3
  // pages of quota; when the shared fleet-wide budget is already critically
  // low, skip it gracefully instead of contributing to the exhaustion.
  if (hasLowHeadroom()) {
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true, skipReason: 'low rate-limit headroom' };
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const owner = 'thomaspryor';
  const repo = 'Broadwayscore';

  try {
    // Cached (shared across every concurrently-dispatched session on this
    // Mac): this is the single most expensive call in health-check.js (up to
    // 3 paginated requests), and health-check.js runs on every /ship-check +
    // /wrap-up across dozens of dispatches/day. `since` is intentionally NOT
    // part of the cache key — it's "last 24h from call time" either way, and
    // pinning the key lets concurrent callers within the TTL window share
    // one result instead of each computing a distinct since= and missing.
    const results = await cachedFetch('workflow-run-summary-24h', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Use REST API with per_page=100 (covers most days in 1-2 calls)
      const runs = [];
      let page = 1;
      const maxPages = 3; // Cap at 300 runs to avoid rate limit issues

      while (page <= maxPages) {
        const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?created=%3E${since}&per_page=100&page=${page}`;
        const response = await fetchJSON(url, { 'Authorization': `token ${token}`, 'User-Agent': 'bsc-health-check' });
        if (!response || !response.workflow_runs) break;
        runs.push(...response.workflow_runs);
        if (response.workflow_runs.length < 100) break;
        page++;
      }
      return runs;
    });

    const completed = results.filter(r => r.status === 'completed');
    const failed = completed.filter(r => r.conclusion === 'failure');

    // Group by workflow name to surface repeat offenders. A workflow failing
    // 4+ consecutive runs gets drowned in the top-5 "latest failures" list
    // (scheduled update-lottery-rush.yml did exactly this 2026-04-10→14).
    // repeatFailures holds workflows with >=2 failures in the window; they're
    // rendered in their own section of the digest so the pattern is visible.
    const byWorkflow = new Map();
    for (const run of failed) {
      const entry = byWorkflow.get(run.name) || { name: run.name, count: 0, latestUrl: null, latestAt: null };
      entry.count += 1;
      if (!entry.latestAt || run.created_at > entry.latestAt) {
        entry.latestAt = run.created_at;
        entry.latestUrl = run.html_url;
      }
      byWorkflow.set(run.name, entry);
    }
    const repeatFailures = Array.from(byWorkflow.values())
      .filter(entry => entry.count >= 2)
      .sort((a, b) => b.count - a.count);

    // Self-heal annotation: a repeat-failure whose streak has demonstrably
    // ENDED (2+ consecutive green completed runs since the last failure) has
    // likely already been fixed — the trailing-24h window just hasn't aged the
    // failures out yet. The Aug 1 Test Suite streak ended 05:10 UTC but the
    // digest fired a "likely broken" Fix-this card ~6.5h later, burning a
    // session on an already-resolved condition. Deliberately NOT a bare
    // latest-run-green check: a flapping workflow (11/19 failures, 2026-06-13)
    // has a green latest run most mornings, and last-successful-run heuristics
    // are the exact blindness repeatFailureResults was built to fix
    // (second-opinion review, 2026-08-01).
    for (const entry of repeatFailures) {
      const conclusions = completed
        .filter(r => r.name === entry.name)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map(r => r.conclusion);
      entry.selfHealed = isRepeatFailureSelfHealed(conclusions);
    }

    return {
      total: completed.length,
      failed: failed.length,
      succeeded: completed.filter(r => r.conclusion === 'success').length,
      failedRuns: failed.slice(0, 5).map(r => ({
        name: r.name,
        url: r.html_url,
        created: r.created_at,
      })),
      repeatFailures,
      skipped: false,
    };
  } catch (err) {
    console.error(`[Workflows] API error: ${err.message}`);
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true, error: err.message };
  }
}

// Promote repeat workflow failures into first-class check results so they flow
// through the same subject-line / escalation / auto-triage machinery as every
// other check, instead of sitting passively in a digest body section (the very
// failure mode that let main test.yml fail 11/19 push runs over 2026-06-13→15
// without bumping the digest off "All clear"). One result per offending
// workflow: 'error' at 3+ failures (clearly broken), 'warn' at exactly 2 (could
// still be a flaky double). Returns [] when there's nothing to surface — clean
// window, or summary skipped (no GH token / API error). Pure (no IO) — unit-
// tested in tests/unit/health-check-repeat-failures.test.mjs.
// Pure (no I/O): a repeat-failure streak counts as self-healed only when the
// 2+ most recent completed runs are ALL green — i.e. the streak provably
// ended. A single trailing green (flappy workflow) is not enough.
// @param {string[]} conclusionsNewestFirst - run conclusions, newest first
function isRepeatFailureSelfHealed(conclusionsNewestFirst) {
  if (!Array.isArray(conclusionsNewestFirst) || conclusionsNewestFirst.length < 2) return false;
  let leadingGreens = 0;
  for (const c of conclusionsNewestFirst) {
    if (c !== 'success') break;
    leadingGreens++;
  }
  return leadingGreens >= 2;
}

function repeatFailureResults(workflowSummary) {
  if (!workflowSummary || workflowSummary.skipped) return [];
  const repeats = workflowSummary.repeatFailures || [];
  return repeats.map(r => ({
    name: `Workflow repeat-failure: ${r.name}`,
    // A provably-ended streak (2+ consecutive trailing greens) downgrades to
    // warn so an already-self-healed condition doesn't drive ACTION NEEDED
    // subjects or invite a Fix-this tap on a resolved streak.
    status: r.selfHealed ? 'warn' : (r.count >= 3 ? 'error' : 'warn'),
    message: `${r.name} failed ${r.count} times in the last 24h`
      + (r.selfHealed
        ? ' — 2+ consecutive green runs since; likely self-healed, failures will age out of the window.'
        : ' — likely broken, not transient.'),
    hint: 'Open the latest run from the Repeat Workflow Failures section of the digest and fix the root cause.',
  }));
}

// Open user-feedback issues that auto-fix punted on (label needs-manual-review).
// The owner deliberately unwatches the repo (process-feedback.yml suppresses
// GitHub notification emails), so these issues have NO notification channel at
// all — Kirsten Weiss's MISTERMAN report (GH #393) sat unseen for 9 days and
// 27 such issues had accumulated by 2026-07-12. The daily digest is the one
// place the owner reliably reads; surface the backlog there.
async function getOpenFeedbackReviewIssues() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return { skipped: true, issues: [] };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const url = 'https://api.github.com/repos/thomaspryor/Broadwayscore/issues?labels=needs-manual-review&state=open&per_page=100';
    // Cached (shared across every concurrently-dispatched session on this Mac).
    const response = await cachedFetch('needs-manual-review-issues',
      () => fetchJSON(url, { 'Authorization': `token ${token}`, 'User-Agent': 'bsc-health-check' }));
    if (!Array.isArray(response)) return { skipped: true, issues: [] };
    return {
      skipped: false,
      issues: response
        .filter(i => !i.pull_request)
        .map(i => ({ number: i.number, title: i.title, createdAt: i.created_at, url: i.html_url })),
    };
  } catch (err) {
    console.error(`[Feedback issues] API error: ${err.message}`);
    return { skipped: true, issues: [] };
  }
}

// Promote the needs-manual-review backlog into a first-class check result so it
// drives the digest subject line like every other warning. Pure (no IO) —
// unit-tested in tests/unit/health-check-repeat-failures.test.mjs.
function feedbackBacklogResults(feedbackSummary, now = new Date()) {
  if (!feedbackSummary || feedbackSummary.skipped) return [];
  const issues = feedbackSummary.issues || [];
  if (issues.length === 0) return [];
  const newest = [...issues].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const oldest = [...issues].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  const oldestDays = Math.floor((now - new Date(oldest.createdAt)) / 86400000);
  return [{
    name: 'Feedback: needs-manual-review backlog',
    status: 'warn',
    message: `${issues.length} open user-feedback issue(s) awaiting manual review (oldest ${oldestDays}d). Newest: #${newest.number} ${String(newest.title).substring(0, 70)}`,
    hint: 'gh issue list --label needs-manual-review — these have NO other notification channel (repo is unwatched by design).',
  }];
}

// Never-run workflow coverage (data/audit/workflow-run-coverage.json, written
// by audit-workflow-hygiene.js's advisory rule (f) — task #737). Surfaces
// registered workflows with a lifetime run count of zero (checkout/secrets/
// npm/script path never once exercised — the #657/#688 class) next to the
// repeat-failure rows above. Pure (no IO) — mirrors repeatFailureResults().
// Free disk on the machine that runs the local automation (2026-08-09).
//
// WHY THIS EXISTS: disk was NOT a monitored signal anywhere. On 2026-08-09 the
// volume sat at 100% (2.0Gi free of 460Gi) and nothing warned — there was no
// digest row, so it could not warn, escalate or page. The only disk logic in the
// repo was scripts/lib/disk-floor-check.sh, which reacts at MERGE time (too late)
// and only as a WARN line inside merge output nobody reads. Every merge that day
// burned minutes on an emergency GC; one took ~25 minutes.
//
// Thresholds are absolute GB, not percentages: what breaks is an operation
// needing N spare GB (a git merge, a next build, a Playwright install), and that
// need does not scale with volume size. 20GB warn gives days of headroom at the
// observed fill rate; 10GB error is roughly two merges from the 5GB floor that
// merge-worktree-to-main.sh already refuses to run under.
function diskSpaceResults(free, total) {
  const NAME = 'Infra: disk space';
  // UNPARSEABLE and ZERO must not share a branch (code-review finding, 2026-08-09).
  // Folding `free <= 0` in here meant a volume so full that `df -h` rounds Avail
  // to 0 — precisely the incident this row exists for — reported as a parse-failure
  // WARN instead of an ERROR. Only a non-finite reading is a parse failure; 0 is a
  // real, and maximally bad, measurement. Negative is impossible from df, so treat
  // it as unparseable.
  if (!Number.isFinite(free) || free < 0) {
    return [{
      name: NAME,
      status: 'warn',
      message: 'Could not read free disk space',
      hint: 'df parsing failed — check the df output shape on this machine.',
    }];
  }
  const pct = Number.isFinite(total) && total > 0 ? Math.round((1 - free / total) * 100) : null;
  const where = `${free}GB free${pct === null ? '' : ` (${pct}% used)`}`;
  if (free < 10) {
    return [{
      name: NAME,
      status: 'error',
      message: `${where} — below the 10GB floor; merges and builds will start failing`,
      hint: 'Reclaim now: git worktree list, drain finished worktrees (gc-merged-worktrees.sh), clear ~/Library/Developer/Xcode/DerivedData and node_modules/.next in stale worktrees.',
    }];
  }
  if (free < 20) {
    return [{
      name: NAME,
      status: 'warn',
      message: `${where} — under 20GB; merge-worktree-to-main.sh starts paying an emergency GC below 5GB`,
      hint: 'Drain finished worktrees before this reaches the floor — the usual source is abandoned dispatch worktrees holding unfinished work.',
    }];
  }
  return [{ name: NAME, status: 'ok', message: where }];
}

// Read free/total GB for the volume holding the repo. Pure `df` parse so it is
// testable; returns NaN on anything unexpected rather than guessing.
function readDiskSpace(dfOutput) {
  const line = String(dfOutput || '').trim().split('\n').pop() || '';
  const cols = line.split(/\s+/);
  const toGB = (v) => {
    const m = /^([\d.]+)([BKMGTPi]*)$/.exec(v || '');
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    const unit = m[2].replace(/i$/, '');
    // 'B' (bytes) is included because a genuinely full volume prints Avail as
    // "0B" / "0Bi" — dropping it would send the worst possible reading down the
    // unparseable path (code-review finding, 2026-08-09). A bare number stays
    // NaN on purpose: this parser is only ever fed `df -h`, which always emits a
    // suffix, so a unitless value means the output is not what we think it is and
    // guessing the unit would risk reporting a full disk as healthy.
    const mult = { B: 1 / 1024 / 1024 / 1024, K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024, P: 1024 * 1024 }[unit];
    return mult === undefined ? NaN : Math.round(n * mult);
  };
  // df -h layout: Filesystem Size Used Avail Capacity ... Mounted
  return { total: toGB(cols[1]), free: toGB(cols[3]) };
}

function neverRunWorkflowResults(report) {
  if (!report || !Array.isArray(report.offenders) || report.offenders.length === 0) return [];
  const list = report.offenders.join(', ');
  return [{
    name: 'Workflow coverage: never-run',
    status: 'warn',
    message: `${report.offenders.length} workflow(s) registered on GitHub Actions with ZERO lifetime runs (>${report.minAgeDays}d old): ${list}`,
    hint: 'checkout/secrets/npm/script path never exercised — give each a dry_run smoke lane (see add-requested-show.yml) and dispatch once.',
  }];
}

// OB closing-date detector candidates (data/audit/ob-closing-candidates.json,
// committed weekly by detect-ob-closings.yml). The detector is alert-only by
// design; without a digest line its report is a JSON file nobody reads — the
// same silent-channel failure as the needs-manual-review backlog above.
function obClosingBacklogResults(report) {
  if (!report || !report.reviewTextSweep) return [];
  const candidates = [
    ...(report.reviewTextSweep.candidates || []),
    ...((report.todaytixStaleness && report.todaytixStaleness.candidates) || []),
  ];
  if (candidates.length === 0) return [];
  const first = candidates[0];
  const label = first.proposedClosingDate
    ? `${first.showId} → ${first.proposedClosingDate} [${first.confidence}]`
    : `${first.showId}`;
  return [{
    name: 'Data: OB closing candidates awaiting review',
    status: 'warn',
    message: `${candidates.length} open Off-Broadway show(s) look closed per the weekly detector. First: ${label}`,
    hint: 'Review data/audit/ob-closing-candidates.json; confirm evidence quotes, then set closingDate/status in shows.json (data repo).',
  }];
}

// Daily-digest surfacing for reverse-discovery missing-show candidates
// (data/audit/reverse-discovery-candidates.json, written daily by
// audit-reverse-discovery.yml). This is the detector's ONLY human-facing
// channel — sendAlert in the CLI is log-only by alert-volume policy.
function reverseDiscoveryBacklogResults(report) {
  if (!report || !Array.isArray(report.candidates) || report.candidates.length === 0) return [];
  const first = report.candidates[0];
  return [{
    name: 'Data: reviewed shows missing from shows.json',
    status: 'warn',
    message: `${report.candidates.length} aggregator-reviewed show(s) not in the catalogue. First: "${first.title}" (${first.source})`,
    hint: 'Review data/audit/reverse-discovery-candidates.json; validate each via node scripts/validate-show-venue.js, then add per CLAUDE.md §3.',
  }];
}

// Daily-digest surfacing for uncollected-live-review strands (data/audit/
// uncollected-live-reviews.json, written hourly by
// audit-uncollected-live-reviews.js — card #1408). That script's own --alert
// flag already pages the totalBlackout case in real time via
// routeAlert(disposition:'auto'); this is the digest-only backstop for
// ordinary strands (a live show still has some coverage, just not every
// discovered URL fetched yet) so the backlog stays visible daily instead of
// silent between hourly runs. 'error' when any show is a total blackout — a
// live show with zero usable critic reviews on site at all, the exact shape
// that let The Winter's Tale and An American Daughter reach opening night
// uncollected on 2026-08-12 — else 'warn' for ordinary strands.
function uncollectedStrandResults(report) {
  if (!report || !Array.isArray(report.findings) || report.findings.length === 0) return [];
  const blackouts = Array.isArray(report.blackoutShows) ? report.blackoutShows : [];
  const first = report.findings[0];
  if (blackouts.length > 0) {
    return [{
      name: 'Data: live show with zero critic reviews on site',
      status: 'error',
      message: `${blackouts.length} live show(s) have discovered review URL(s) but NOTHING collected. First: ${blackouts[0]}`,
      hint: 'data/audit/uncollected-live-reviews.json has the per-outlet list. Recover: gh workflow run opening-night-express.yml -f show_id=<id> -f market=<market>.',
    }];
  }
  return [{
    name: 'Data: uncollected live review strands',
    status: 'warn',
    message: `${report.strandedFiles} discovered review URL(s) across ${report.findings.length} live show(s) were never fetched. First: ${first.showId} (${first.stranded.length} stranded)`,
    hint: 'data/audit/uncollected-live-reviews.json has the per-outlet list. Recover: gh workflow run opening-night-express.yml -f show_id=<id> -f market=<market>.',
  }];
}

// Daily-digest surfacing for T1/T2 silent review gaps (data/audit/
// t1-silent-gaps.json, written hourly by audit-t1-silent-gaps.js). Real-time
// CRITICAL email only fires for gaps on near-opening shows; everything else
// lands here so the back-catalogue backlog is visible once a day instead of
// one email per discovery (2026-07-19 alert-volume fix).
function silentGapBacklogResults(report) {
  if (!report || !Array.isArray(report.gaps) || report.gaps.length === 0) return [];
  const gaps = report.gaps;
  const t1 = gaps.filter((g) => g.tier === 1).length;
  const first = gaps[0];
  return [{
    name: 'Data: T1/T2 silent review gaps',
    status: 'warn',
    message: `${gaps.length} discovered review(s) not reaching the composite score (${t1} T1). First: ${first.showId} — ${first.outletId} (${first.type})`,
    hint: 'Each entry in data/audit/t1-silent-gaps.json carries its fix command (run locally — cookie jar). Sweep card: Silent-gap 120d sweep remainder.',
  }];
}

// Daily-digest surfacing for undispatchable backlog cards (data/audit/
// card-verifiability.json, written by audit-card-verifiability.js — task
// #646). bsc-next correctly refuses to dispatch a card with no runnable
// acceptance-criteria command, but that refusal has no channel of its own —
// a card can sit stuck indefinitely with nobody noticing. enrich-card-
// acceptance.js is the fix; this warn row is the visibility that was missing
// before it existed (#116 sat refused until a human hand-enriched it).
function cardVerifiabilityBacklogResults(report, drainMetric) {
  const results = [];
  if (report && Array.isArray(report.refused) && report.refused.length > 0) {
    const refused = report.refused;
    const first = refused[0];
    results.push({
      name: 'Data: undispatchable backlog cards',
      status: 'warn',
      message: `${refused.length} of ${report.total} pending/in-progress card(s) have no runnable acceptance-criteria command (bsc-next would refuse them). First: [${first.priority || '?'}] ${first.name}`,
      hint: 'node scripts/enrich-card-acceptance.js --from-report drafts missing criteria (or VERIFY: owner-judgment for human-only cards). Re-run node scripts/audit-card-verifiability.js after to confirm.',
    });
  }
  // Task #1004's sibling bucket: cards the drain scanned and skipped because an
  // UNATTENDED session structurally cannot finish them (owner visual-qa
  // approval, an owner decision, a completion deferred past the session). The
  // classifier writes humanGatedSkips into the drain metric; without this row
  // that field is write-only and a MISCLASSIFIED card would be skipped silently
  // on every tick forever, its only trace a launchd log nobody reads — the exact
  // #689/#690 write-only class.
  const gated = (drainMetric && Array.isArray(drainMetric.humanGatedSkips)) ? drainMetric.humanGatedSkips : [];
  if (gated.length > 0) {
    const codes = [...new Set(gated.flatMap(g => g.codes || []))].join(', ');
    results.push({
      name: 'Data: cards the drain cannot finish unattended',
      status: 'warn',
      message: `backlog-drain skipped ${gated.length} card(s) needing a human to finish (#${gated.map(g => g.id).join(', #')}) — blockers: ${codes || 'unspecified'}. These will never drain headlessly.`,
      hint: 'Dispatch them to a cmux tab (node scripts/bsc-next.js --id <n>, no --headless) where you can clear the gate. If a card is MISCLASSIFIED, check it against node scripts/lib/headless-dispatchability.js --subject="..." --notes="..." and fix the classifier, not the card.',
    });
  }
  return results;
}

// Daily-digest surfacing for stalled pipeline surfaces (data/audit/
// progress-watch-state.json, written by check-progress-stalls.js — task
// #597). Existing audits (repeatFailureResults et al above) only ever assert
// a SAFETY property (present / under threshold); this is the one LIVENESS
// check — has a registered counter actually moved across recent runs, not
// just stayed within bounds. A queue depth pinned at the same number for
// days passes every other check in this file.
function progressWatchResults(report) {
  if (!report || !report.surfaces) return [];
  const stalled = Object.values(report.surfaces).filter((s) => s.stalled);
  if (stalled.length === 0) return [];
  // report.lastSummary carries whatever extra context a surface's loadData()
  // returned beyond the tracked value itself (e.g. check-progress-stalls.js's
  // raw/notScoreable/blocked breakdown, task #751) — surfaced generically
  // here rather than as named fields so this function stays metric-agnostic
  // as new monitors attach their own context shapes (task #761). Guarded:
  // lastSummary is producer-supplied and unvalidated, so a JSON.stringify
  // failure (circular ref, BigInt) must not take down the whole alert — the
  // caller's try/catch would otherwise swallow value/cycles/hint too, silently
  // disabling the file's one liveness check (adversarial review, task #761).
  let context = '';
  if (report.lastSummary) {
    try {
      const serialized = JSON.stringify(report.lastSummary);
      context = ` Context: ${serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized}`;
    } catch { /* unserializable lastSummary — omit context, don't drop the alert */ }
  }
  return stalled.map((s) => ({
    name: `Progress watch: ${s.label} stalled`,
    status: 'warn',
    message: `${s.label} is at ${s.value} and hasn't moved in ${s.cycles} consecutive check(s).${context}`,
    hint: s.hint || 'Investigate whether the producer/consumer for this surface is actually running.',
  }));
}

// Daily-digest surfacing for BWW-roundup discovery misses near opening (task
// #692). data/audit/bww-roundup-miss-ledger.jsonl (Scraping v2 Sprint 1 T6)
// is append-only and, until now, had exactly one reader — the write path's
// own cooldown check. A show that keeps missing discovery INSIDE its
// opening-window (where the miss-cooldown deliberately never suppresses
// retries — see OPENING_WINDOW_DAYS in bww-roundup-persistence.js) is
// exactly the case worth a human look: the roundup may genuinely not be
// published yet, or discovery may be broken for that show.
function bwwRoundupMissBacklogResults(summary) {
  if (!summary || summary.length === 0) return [];
  const first = summary[0];
  return [{
    name: 'Data: BWW roundup discovery misses near opening',
    status: 'warn',
    message: `${summary.length} show(s) with 2+ BWW-roundup discovery misses in the trailing 48h, inside their opening window. First: ${first.showId} (${first.missCount} misses, last ${first.lastMissTs}).`,
    hint: 'Check data/audit/bww-roundup-miss-ledger.jsonl. Per CLAUDE.md rule 14, a pre-opening 404 is normal — confirm the roundup genuinely hasn\'t published before treating this as a discovery bug.',
  }];
}

// Simple HTTPS GET that returns parsed JSON
function fetchJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = require('https').request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { ...headers, 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// --- Email Digest ---

/**
 * Subject line spec:
 *   Green: 0 errors, <=2 warnings → "BSC Daily: All clear (27/27 passed)"
 *   Yellow: 1+ warnings OR 1-2 errors → "BSC Daily: 2 warnings — [first warning name]"
 *   Red: 3+ errors OR any error 2+ consecutive days → "BSC Daily: ACTION NEEDED — [first error name]"
 */
// Fingerprint of the actionable, un-auto-fixed error set — the unit of "is this
// the same bad news as yesterday". Sorted names only (not messages) so a count
// drifting inside one check doesn't read as new news, but a NEW failing check or
// a recovery always changes the print.
function errorSetFingerprint(unfixedErrors) {
  return unfixedErrors.map(r => r.name).sort().join('|');
}

// Escalation milestones: an UNCHANGED error set screams on day 1 (implicit —
// it's new), day 3, day 7, then weekly. Every other day it rides the calm
// daily subject. This is what makes "BSC URGENT (day 6)" AND "(day 7)" on
// consecutive mornings structurally impossible (owner escalation 2026-07-25:
// 7 straight URGENT days for the same unresolved set).
function isEscalationDay(days) {
  return days === 3 || days === 7 || (days > 7 && (days - 7) % 7 === 0);
}

function getDigestSubject(results, history, autoFixResults) {
  const errors = results.filter(r => r.status === 'error');
  const warns = results.filter(r => r.status === 'warn');
  const total = results.length;
  const passed = results.filter(r => r.status === 'pass').length;
  const fixMap = autoFixResults || {};

  // Only count items that are NOT auto-fixed AND are actionable (not LOW priority)
  const isActionable = (r) => {
    const entry = getPlaybookEntry(r.name);
    return !entry || entry.urgency !== 'low';
  };
  const unfixedErrors = errors.filter(r => !fixMap[r.name]?.fixed && isActionable(r));
  const unfixedWarns = warns.filter(r => !fixMap[r.name]?.fixed && isActionable(r));
  const autoFixedCount = Object.values(fixMap).filter(f => f.fixed).length;

  const days = history.consecutiveErrorDays || 0;
  const sameSetAsYesterday = unfixedErrors.length > 0
    && history.lastErrorFingerprint === errorSetFingerprint(unfixedErrors);

  if (unfixedErrors.length > 0 && days >= 5) {
    if (!sameSetAsYesterday || isEscalationDay(days)) {
      return `BSC URGENT (day ${days}): ${unfixedErrors.length} unresolved error${unfixedErrors.length > 1 ? 's' : ''}`;
    }
    // Same unresolved set, non-milestone day: calm subject, no repeat scream.
    return `BSC Daily: ${unfixedErrors.length} known issue${unfixedErrors.length > 1 ? 's' : ''} (unchanged, day ${days})`;
  }
  if (unfixedErrors.length >= 3 || (unfixedErrors.length > 0 && days >= 2)) {
    if (sameSetAsYesterday && days >= 2 && !isEscalationDay(days)) {
      return `BSC Daily: ${unfixedErrors.length} known issue${unfixedErrors.length > 1 ? 's' : ''} (unchanged, day ${days})`;
    }
    const first = unfixedErrors[0]?.name || 'unknown';
    return `BSC Daily: ACTION NEEDED — ${first}`;
  }
  if (unfixedErrors.length > 0) {
    return `BSC Daily: ${unfixedErrors.length} error${unfixedErrors.length > 1 ? 's' : ''} need attention`;
  }
  if (unfixedWarns.length > 0) {
    const autoNote = autoFixedCount > 0 ? ` (${autoFixedCount} auto-fixed)` : '';
    return `BSC Daily: ${unfixedWarns.length} warning${unfixedWarns.length > 1 ? 's' : ''}${autoNote}`;
  }
  if (autoFixedCount > 0) {
    return `BSC Daily: All clear — ${autoFixedCount} issue${autoFixedCount > 1 ? 's' : ''} auto-fixed`;
  }
  return `BSC Daily: All clear (${passed}/${total} passed)`;
}

// Post-digest: persist today's unfixed-actionable error set so tomorrow's
// subject can tell "unchanged" from "new/worse/recovered". Mirrors the exact
// filter getDigestSubject applies (auto-fixed and low-urgency excluded).
function updateErrorFingerprint(history, results, autoFixResults) {
  const fixMap = autoFixResults || {};
  const isActionable = (r) => {
    const entry = getPlaybookEntry(r.name);
    return !entry || entry.urgency !== 'low';
  };
  const unfixedErrors = results.filter(r => r.status === 'error' && !fixMap[r.name]?.fixed && isActionable(r));
  history.lastErrorFingerprint = unfixedErrors.length ? errorSetFingerprint(unfixedErrors) : '';
  return history;
}

function getStatusColor(status) {
  return status === 'pass' ? '#2ecc71' : status === 'warn' ? '#f39c12' : '#e74c3c';
}

function getStatusIcon(status) {
  return status === 'pass' ? '&#9989;' : status === 'warn' ? '&#9888;&#65039;' : '&#10060;';
}

function purgeOldExclusionLogs(retentionDays = 30) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      const m = f.match(/^exclusions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (new Date(m[1]).getTime() < cutoff) {
        fs.unlinkSync(path.join(AUDIT_DIR, f));
        deleted.push(f);
      }
    }
    if (deleted.length) console.log(`[Exclusion Logs] Purged ${deleted.length} file(s) older than ${retentionDays}d: ${deleted.join(', ')}`);
  } catch (err) {
    console.warn(`[Exclusion Logs] Purge failed (non-fatal): ${err.message}`);
  }
}

/**
 * Render the "OB Discovery — Action Needed" digest section. Pure (no IO) so it
 * can be unit-tested: returns '' when there's nothing to surface (silent zero
 * weeks), otherwise an HTML block naming the staged count + promoter command.
 */
function buildObCandidatesHtml(staged, typoCount) {
  const list = Array.isArray(staged) ? staged : [];
  const typos = Number(typoCount) || 0;
  const stagedCount = list.length;
  if (stagedCount === 0 && typos === 0) return '';

  const color = stagedCount >= 5 ? '#f39c12' : '#aaa';
  const parts = [];
  if (stagedCount > 0) {
    parts.push(`<p style="color:#ccc;margin:4px 0;font-size:13px;">
        ${stagedCount} OB candidate${stagedCount === 1 ? '' : 's'} staged for review — promotion is human-gated.
        Run <code style="color:#fff;">node scripts/promote-ob-venue-candidates.js --dry-run</code> to review, then drop <code>--dry-run</code> to add.
      </p>`);
    const top = list.slice(0, 5).map(c =>
      `<li style="color:#ccc;margin-bottom:4px;font-size:13px;">${c.title || '?'} <span style="color:#666;">@ ${c.venue || '?'}</span> <span style="color:#666;">· ${c.source || 'venue-scan'}</span></li>`
    ).join('');
    if (top) parts.push(`<ul style="padding-left:20px;margin:4px 0;">${top}</ul>`);
  }
  if (typos > 0) {
    parts.push(`<p style="color:#f39c12;margin:4px 0;font-size:13px;">
        ${typos} aggregator slug typo${typos === 1 ? '' : 's'} need${typos === 1 ? 's' : ''} a source fix (e.g. a BWW Review-Roundup slug) — see data/audit/ob-aggregator-rejections.json.
      </p>`);
  }
  return `
        <h3 style="color:${color};margin:24px 0 8px;">OB Discovery — Action Needed</h3>
        ${parts.join('')}
      `;
}

function buildExclusionSummaryHtml() {
  try {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const summaryFile = path.join(AUDIT_DIR, 'exclusion-summary-yesterday.json');

    // Read today's and yesterday's JSONL files
    const todayPath = getTodayJsonlPath();
    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterdayPath = path.join(path.dirname(todayPath), `exclusions-${yesterday}.jsonl`);

    if (!fs.existsSync(todayPath)) {
      return '<p style="color:#e74c3c;font-size:13px;margin:4px 0;">⚠️ No exclusion log for today — rebuild/gather/collect may not have run.</p>';
    }

    const records = [];
    for (const p of [yesterdayPath, todayPath]) {
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          if (new Date(r.ts).getTime() >= cutoff) records.push(r);
        } catch {}
      }
    }

    // Count by reason
    const counts = {};
    const showIdsByReason = {};
    for (const r of records) {
      counts[r.reason] = (counts[r.reason] || 0) + 1;
      if (!showIdsByReason[r.reason]) showIdsByReason[r.reason] = new Set();
      if (r.showId && r.showId !== 'unknown') showIdsByReason[r.reason].add(r.showId);
    }

    // Load yesterday's counts for spike detection
    let yesterday_counts = {};
    try {
      if (fs.existsSync(summaryFile)) {
        yesterday_counts = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
      }
    } catch {}

    // Persist today's counts for tomorrow
    try { fs.writeFileSync(summaryFile, JSON.stringify(counts, null, 2)); } catch {}

    if (Object.keys(counts).length === 0) {
      return '<p style="color:#888;font-size:13px;margin:4px 0;">No exclusions logged in last 24h.</p>';
    }

    const top10 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const rows = top10.map(([reason, count]) => {
      const prev = yesterday_counts[reason];
      let badge = '';
      if (prev == null) {
        badge = ' <span style="color:#3498db;font-size:11px;">🆕 NEW</span>';
      } else if (prev > 0 && count / prev > 1.5) {
        badge = ` <span style="color:#e74c3c;font-size:11px;">⚠️ SPIKE (was ${prev})</span>`;
      }
      const topShows = Array.from(showIdsByReason[reason] || []).slice(0, 3).join(', ') || '—';
      return `<tr>
        <td style="padding:4px 8px;color:#ccc;font-size:12px;font-family:monospace;">${reason}${badge}</td>
        <td style="padding:4px 8px;color:#fff;text-align:center;font-size:12px;">${count}</td>
        <td style="padding:4px 8px;color:#888;font-size:11px;">${topShows}</td>
      </tr>`;
    }).join('');

    return `
      <h3 style="color:#aaa;margin:24px 0 8px;">Exclusion summary (last 24h)</h3>
      <table style="width:100%;border-collapse:collapse;background:#16213e;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="border-bottom:1px solid #333;">
            <th style="padding:4px 8px;text-align:left;color:#888;font-size:11px;text-transform:uppercase;">Reason</th>
            <th style="padding:4px 8px;text-align:center;color:#888;font-size:11px;text-transform:uppercase;">Count</th>
            <th style="padding:4px 8px;text-align:left;color:#888;font-size:11px;text-transform:uppercase;">Top Shows</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (err) {
    return `<p style="color:#e74c3c;font-size:13px;margin:4px 0;">⚠️ Exclusion summary error: ${err.message}</p>`;
  }
}

// Card #364 (owner merge decision 2026-07-26 — "I don't like getting emails
// unless they're urgent. I want things to self handle."): this function used
// to email its own "BSC Daily"/"BSC URGENT" digest via Resend, landing
// separately from the autonomous loop's morning email. It no longer sends
// mail at all — it still runs every check, still dispatches Action Queue
// cards for humanAction items via routeAlert (disposition='auto', unrelated
// to email delivery), and now WRITES its results to
// HEALTH_DIGEST_SNAPSHOT_FILE instead. autonomous-email.js reads that
// snapshot and folds it into the one scheduled morning email, so the owner
// gets exactly one scheduled email/day instead of two.
async function sendEmailDigest(results, history, workflowSummary, autoFixResults) {
  // Drain owner-alert-router's digest queue (data/audit/alert-digest-queue.json)
  // — the ONE consumer, since drainDigestQueue() had no production caller
  // before this (card #475 ship-check finding): every disposition='digest'
  // routeAlert() call was queuing a line that nothing ever read back out, so
  // those conditions were silently dropped rather than reaching the owner in
  // the digest as the router's own design intends. Drained here, once per
  // real send (this function is the single production call site), so a
  // condition queued between digests always appears in the next one.
  // PEEK, don't drain: ~430 lines of rendering run before the snapshot below
  // is written, and a read-and-clear here loses every queued line permanently
  // if any of that throws (the ledger already marked those conditions
  // notified, so they are never re-queued). Cleared only after the snapshot
  // file is on disk.
  const queuedDigestItems = peekDigestQueue();
  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const subject = getDigestSubject(results, history, autoFixResults);
  const errors = results.filter(r => r.status === 'error');
  const warns = results.filter(r => r.status === 'warn');
  const passed = results.filter(r => r.status === 'pass');

  // Group by category
  const categories = {};
  for (const r of results) {
    const cat = r.name.split(':')[0].trim();
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(r);
  }

  // Build category summary rows
  const catRows = Object.entries(categories).map(([cat, checks]) => {
    const catPassed = checks.filter(c => c.status === 'pass').length;
    const catTotal = checks.length;
    const worst = checks.some(c => c.status === 'error') ? 'error' : checks.some(c => c.status === 'warn') ? 'warn' : 'pass';
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #333;color:#ccc;">${getStatusIcon(worst)} ${cat}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #333;color:${getStatusColor(worst)};text-align:center;">${catPassed}/${catTotal}</td>
    </tr>`;
  }).join('');

  // Action section — split into auto-fixed and needs-your-attention
  let actionHtml = '';
  const actionItems = [...errors, ...warns];
  const autoFixMap = autoFixResults || {};

  if (actionItems.length > 0) {
    const URGENCY_LABELS = {
      'fix-now': { label: 'FIX NOW', bg: '#e74c3c', color: '#fff' },
      'this-week': { label: 'THIS WEEK', bg: '#f39c12', color: '#fff' },
      'low': { label: 'LOW', bg: '#555', color: '#ccc' },
    };

    const autoFixed = [];
    const needsAttention = [];
    for (const r of actionItems) {
      const fix = autoFixMap[r.name];
      if (fix && fix.fixed) {
        autoFixed.push(r);
      } else {
        needsAttention.push(r);
      }
    }

    // Auto-fixed section (green — no action needed from user)
    let autoFixedHtml = '';
    if (autoFixed.length > 0) {
      const items = autoFixed.map(r => {
        const fix = autoFixMap[r.name];
        return `<div style="padding:8px 12px;margin-bottom:6px;background:#1a3a1a;border-left:3px solid #2ecc71;border-radius:4px;">
          <span style="color:#2ecc71;font-weight:bold;">&#9989; Auto-fixed</span>
          <span style="color:#ccc;margin-left:8px;">${r.name.split(': ').pop()}</span>
          <br><span style="color:#888;font-size:12px;">Triggered ${fix.workflow} — should resolve within ~30 min</span>
        </div>`;
      }).join('');
      autoFixedHtml = `
        <h3 style="color:#2ecc71;margin:24px 0 8px;">Auto-Fixed (no action needed)</h3>
        ${items}
      `;
    }

    // Needs attention section — only FIX NOW and THIS WEEK shown; LOW items just get a count
    let needsAttentionHtml = '';
    if (needsAttention.length > 0) {
      const actionable = [];
      const lowCount = { count: 0 };
      for (const r of needsAttention) {
        const entry = getPlaybookEntry(r.name);
        let urgencyLevel = entry ? entry.urgency : 'low';

        // Smart escalation: if auto-fix was attempted but issue persists 3+ days, upgrade urgency
        const fix = autoFixMap[r.name];
        if (fix && !fix.fixed && fix.message) {
          // Auto-fix failed — escalate
          if (urgencyLevel === 'low') urgencyLevel = 'this-week';
        }
        // Check triage history for persistent issues
        const checkSlug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        try {
          const triageFile = path.join(TRIAGE_DIR, `autofix-${checkSlug}.json`);
          if (fs.existsSync(triageFile)) {
            const triage = readJSON(triageFile);
            if ((triage.autoFixAttempts || 0) >= 2 && urgencyLevel === 'low') {
              urgencyLevel = 'this-week'; // Tried to auto-fix twice and still broken
            }
          }
        } catch {}

        if (urgencyLevel === 'low') {
          lowCount.count++;
        } else {
          actionable.push({ ...r, _escalatedUrgency: urgencyLevel });
        }
      }

      // Owner-alert-router migration (Notion 3a4637c5-416f-81eb, #279): every
      // playbook entry with a `humanAction` (no `workflow` — those already
      // auto-fix via GH workflow dispatch above) used to render a raw
      // "open Claude Code and say: ..." paste-prompt in the email. Instead,
      // file an Action Queue card once per open incident so
      // notion-action-poll.js works it hands-free; the email links the card
      // instead of asking the owner to paste anything. Runs BEFORE the
      // synchronous items.map() below so the (async) dispatch result is
      // available to it.
      //
      // Capped at MAX_CARD_DISPATCHES_PER_RUN: each dispatch shells out to
      // notion-brain.js (up to a few seconds, more if Notion is degraded) —
      // sequential dispatch of a large first-run/post-outage backlog could
      // otherwise eat into this job's 10-min timeout. Anything past the cap
      // still gets its playbook instruction text in the email (uncapped),
      // just without a filed card this run; it'll dispatch next run.
      const MAX_CARD_DISPATCHES_PER_RUN = 8;
      const dispatchedCards = {};
      let dispatchBudget = MAX_CARD_DISPATCHES_PER_RUN;
      let dispatchCapped = false;
      for (const r of actionable) {
        const entry = getPlaybookEntry(r.name);
        if (!entry || entry.workflow || !entry.humanAction) continue;
        if (dispatchBudget <= 0) { dispatchCapped = true; continue; }
        dispatchBudget--;
        try {
          const result = await routeAlert({
            conditionKey: `health-check:${r.name}`,
            title: `BSC Daily: ${r.name}`,
            description: `${r.message}${r.hint ? `\n\n${r.hint}` : ''}`,
            hint: entry.humanAction,
            severity: r.status === 'error' ? 'error' : 'warning',
            disposition: 'auto',
            fields: [{ name: 'Check', value: r.name }],
          });
          dispatchedCards[r.name] = result;
        } catch (err) {
          console.error(`[Alert Router] dispatch failed for "${r.name}": ${err.message}`);
        }
      }
      if (dispatchCapped) {
        console.log(`[Alert Router] hit MAX_CARD_DISPATCHES_PER_RUN=${MAX_CARD_DISPATCHES_PER_RUN} — remaining humanAction items will dispatch next run`);
      }

      const items = actionable.map(r => {
        const entry = getPlaybookEntry(r.name);
        const urgency = URGENCY_LABELS[r._escalatedUrgency || (entry ? entry.urgency : 'low')] || URGENCY_LABELS['low'];
        const dispatch = dispatchedCards[r.name];
        const instruction = dispatch
          ? (dispatch.action === 'silent'
              // Rail 2 (task #1341): a Linear-deduped condition never filed a
              // Notion card — say where the tracker actually lives, or the
              // owner goes hunting for an Action Queue card that doesn't exist.
              ? (dispatch.linearIdentifier
                  ? `${entry.humanAction} — already tracked as ${dispatch.linearIdentifier} in Linear (still open).`
                  : `${entry.humanAction} — already dispatched to the Action Queue (still open).`)
              : dispatch.dispatchOk === false
                // Surface the REAL captured error, not a guess — this exact
                // line used to hardcode "Check logs / NOTION_API_KEY", which
                // is what sent every session chasing the wrong cause during
                // the 2026-07-24 npm-ci incident (the real error was
                // "Cannot find module '@notionhq/client'").
                ? `${entry.humanAction} — tracker filing failed, will retry next run. Error: ${(dispatch.dispatchError || '(no error captured)').slice(0, 200)}`
                // BRO-286 honesty: name the filed issue; never claim
                // hands-free work without a journaled dispatch (the parked-
                // issue drain is a Phase 2 follow-up still in build).
                : (dispatch.linearIdentifier
                    ? `${entry.humanAction} — filed as ${dispatch.linearIdentifier} in Linear for triage.`
                    : `${entry.humanAction} — tracker filed in Linear for triage.`))
          : entry
            ? (entry.humanAction || entry.humanFallback || r.message)
            : r.message;
        const fix = autoFixMap[r.name];
        const failNote = fix && fix.message
          ? `<br><span style="color:#e74c3c;font-size:11px;">Couldn't auto-fix. ${entry?.workflow ? `<a href="https://github.com/thomaspryor/Broadwayscore/actions/workflows/${entry.workflow}" style="color:#e74c3c;text-decoration:underline;">Tap to retry manually</a>` : ''}</span>`
          : '';

        // Show per-cookie countdowns if available
        const countdowns = (entry?.useCountdown && r.cookieCountdowns?.length > 0)
          ? `<p style="color:#f39c12;margin:4px 0 0;font-size:12px;">${r.cookieCountdowns.join(' · ')}</p>`
          : '';

        // One-tap approve button for fix-now items with a known fix workflow
        const urgencyLevel = r._escalatedUrgency || (entry ? entry.urgency : 'low');
        const approveUrl = urgencyLevel === 'fix-now' && entry?.workflow
          ? generateApproveUrl(entry.workflow, r.name)
          : '';
        const approveButton = approveUrl
          ? `<div style="margin-top:10px;">
              <a href="${approveUrl}" style="display:inline-block;background:#27ae60;color:white;padding:8px 18px;border-radius:5px;text-decoration:none;font-weight:bold;font-size:13px;">Run Fix</a>
              <span style="color:#666;font-size:11px;margin-left:8px;">Triggers ${entry.workflow} &nbsp;·&nbsp; Link expires in 24h</span>
            </div>`
          : '';

        return `<div style="padding:10px 12px;margin-bottom:8px;background:#2a1a1a;border-left:3px solid ${urgency.bg};border-radius:4px;">
          <span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${urgency.bg};color:${urgency.color};font-size:11px;font-weight:bold;">${urgency.label}</span>
          <span style="color:#ddd;margin-left:8px;font-weight:bold;">${r.name.split(': ').pop()}</span>
          ${countdowns}
          <p style="color:#bbb;margin:6px 0 0;font-size:13px;line-height:1.4;">${instruction}</p>
          ${failNote}
          ${approveButton}
        </div>`;
      }).join('');

      const lowNote = lowCount.count > 0
        ? `<p style="color:#666;font-size:12px;margin-top:8px;">+ ${lowCount.count} low-priority item${lowCount.count > 1 ? 's' : ''} monitoring themselves (no action needed)</p>`
        : '';

      if (actionable.length > 0) {
        needsAttentionHtml = `
          <h3 style="color:#f39c12;margin:24px 0 8px;">Needs Your Attention</h3>
          ${items}
          ${lowNote}
        `;
      } else if (lowCount.count > 0) {
        needsAttentionHtml = `
          <p style="color:#666;font-size:12px;margin:24px 0 8px;">${lowCount.count} low-priority item${lowCount.count > 1 ? 's' : ''} monitoring themselves (no action needed)</p>
        `;
      }
    }

    actionHtml = autoFixedHtml + needsAttentionHtml;
  }

  // Mezzanine title-coverage drift section. Surfaces likely-mismatched titles
  // that the scraper failed to bridge (normalize gap or missing override).
  // Audit file is written by scripts/scrape-mezzanine-audience.js on every
  // full run. Wired to email after the 2026-04-28 What Happened Was incident.
  let mezzanineCoverageHtml = '';
  try {
    const mezzAuditPath = path.join(__dirname, '..', 'data', 'audit', 'mezzanine-coverage.json');
    if (fs.existsSync(mezzAuditPath)) {
      const audit = JSON.parse(fs.readFileSync(mezzAuditPath, 'utf8'));
      const count = audit.count || 0;
      if (count > 0) {
        const ageMs = Date.now() - new Date(audit.lastUpdated || 0).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        const stale = ageDays > 14;
        const color = count >= 10 ? '#e74c3c' : count >= 5 ? '#f39c12' : '#aaa';
        const heading = count >= 10
          ? '⚠️ Mezzanine Coverage Drift (action recommended)'
          : count >= 5
          ? 'Mezzanine Coverage — Review When Convenient'
          : 'Mezzanine Coverage';
        const top = (audit.flagged || []).slice(0, 5).map(f =>
          `<li style="color:#ccc;margin-bottom:4px;font-size:13px;">${f.ratingsCount} ratings · ${f.ourTitle} <span style="color:#666;">↔</span> ${f.mezzName} <span style="color:#666;">@ ${f.theater || '?'}</span></li>`
        ).join('');
        mezzanineCoverageHtml = `
          <h3 style="color:${color};margin:24px 0 8px;">${heading}</h3>
          <p style="color:#ccc;margin:4px 0;font-size:13px;">
            ${count} Mezzanine production${count === 1 ? '' : 's'} fuzzy-matches an open/recent show but didn't link.
            Likely a missing MEZZANINE_OVERRIDES entry or a normalize gap in scripts/lib/title-match.js.
            ${stale ? `<br><span style="color:#888;">Last audit run ${ageDays}d ago — Mezzanine cron may be stuck.</span>` : ''}
          </p>
          ${top ? `<ul style="padding-left:20px;margin:4px 0;">${top}</ul>` : ''}
          <p style="color:#666;font-size:12px;margin:4px 0;">Full list: data/audit/mezzanine-coverage.json</p>
        `;
      }
    }
  } catch (e) {
    console.log(`[Mezzanine Coverage] Skipped — ${e.message}`);
  }

  // OB-discovery candidates awaiting human promotion. extract-aggregator-
  // candidates.js + the venue-listing scrapers stage candidates into
  // ob-venue-candidates.json weekly, but promotion to shows.json is human-gated
  // (CLAUDE.md §3) — the whole bridge is inert if nobody runs the promoter.
  // Surface the backlog (+ any aggregator slug typos that need a source fix)
  // until it's acted on. Silent when both counts are zero.
  let obCandidatesHtml = '';
  try {
    const stagingPath = path.join(__dirname, '..', 'data', 'audit', 'ob-venue-candidates.json');
    const rejectionsPath = path.join(__dirname, '..', 'data', 'audit', 'ob-aggregator-rejections.json');
    let staged = [];
    if (fs.existsSync(stagingPath)) {
      const d = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
      if (Array.isArray(d)) staged = d;
    }
    let typoCount = 0;
    if (fs.existsSync(rejectionsPath)) {
      const rj = JSON.parse(fs.readFileSync(rejectionsPath, 'utf8'));
      typoCount = (rj.counts && rj.counts.byReason && rj.counts.byReason['typo-detected']) || 0;
    }
    obCandidatesHtml = buildObCandidatesHtml(staged, typoCount);
  } catch (e) {
    console.log(`[OB Candidates] Skipped — ${e.message}`);
  }

  // Workflow runs section
  let workflowHtml = '';
  if (workflowSummary && !workflowSummary.skipped) {
    const repeats = workflowSummary.repeatFailures || [];
    const repeatHtml = repeats.length > 0
      ? `
        <h3 style="color:#e74c3c;margin:24px 0 8px;">⚠️ Repeat Workflow Failures (24h)</h3>
        <p style="color:#ccc;margin:4px 0;">
          These workflows failed 2+ times in the last 24 hours. Entries without a self-healed note are likely broken, not transient.
        </p>
        <ul style="padding-left:20px;margin:4px 0;">
          ${repeats.map(r => `<li style="color:${r.selfHealed ? '#f1c40f' : '#e74c3c'};margin-bottom:4px;"><strong>${r.name}</strong> — ${r.count} failures${r.selfHealed ? ' — likely self-healed (2+ green runs since)' : ''} — <a href="${r.latestUrl}" style="color:${r.selfHealed ? '#f1c40f' : '#e74c3c'};">latest run</a></li>`).join('')}
        </ul>
      `
      : '';
    const failedList = workflowSummary.failedRuns.length > 0
      ? workflowSummary.failedRuns.map(r => `<li style="color:#e74c3c;margin-bottom:4px;"><a href="${r.url}" style="color:#e74c3c;">${r.name}</a></li>`).join('')
      : '';
    workflowHtml = `
      ${repeatHtml}
      <h3 style="color:#aaa;margin:24px 0 8px;">Workflow Runs (24h)</h3>
      <p style="color:#ccc;margin:4px 0;">
        ${workflowSummary.succeeded} succeeded, ${workflowSummary.failed} failed (${workflowSummary.total} total)
      </p>
      ${failedList ? `<ul style="padding-left:20px;margin:4px 0;">${failedList}</ul>` : ''}
    `;
  }

  // Render whatever queued this run (or a prior run, if this is the first
  // digest since — the queue survives until drained). Escaped: titles/
  // descriptions originate from repo code, not user input, but several carry
  // LLM-authored or aggregator-sourced text (e.g. UX walkthrough findings).
  const digestQueueHtml = queuedDigestItems.length > 0
    ? `
      <h3 style="color:#aaa;margin:24px 0 8px;">Automation (queued)</h3>
      <ul style="padding-left:20px;margin:4px 0;">
        ${queuedDigestItems.map(q => `<li style="color:#ccc;margin-bottom:4px;"><strong>${escapeHtml(q.title)}</strong>${q.description ? ` — ${escapeHtml(q.description)}` : ''}</li>`).join('')}
      </ul>
    `
    : '';

  // Owner email volume (7d) — card #475 regression guard: makes creep in the
  // number of CRITICAL emails visible in the ONE place already read daily,
  // instead of requiring a manual inbox comb the next time volume spikes.
  let ownerEmailHtml = '';
  try {
    const sent = readOwnerEmailLog({ days: 7 });
    if (sent.length > 0) {
      const bySender = new Map();
      for (const e of sent) {
        // Bucket by the text before the first colon (e.g. "Secret Health
        // Check — 2 Failed" has none, so falls back to the full title) —
        // good enough to spot one sender dominating the week's volume
        // without needing per-caller instrumentation.
        const key = (e.title || 'unknown').split(':')[0].trim().slice(0, 60);
        bySender.set(key, (bySender.get(key) || 0) + 1);
      }
      const rows = [...bySender.entries()].sort((a, b) => b[1] - a[1]);
      const rowsHtml = rows.map(([name, count]) =>
        `<li style="color:#ccc;margin-bottom:2px;">${count}&times; — ${name}</li>`).join('');
      ownerEmailHtml = `
        <h3 style="color:#aaa;margin:24px 0 8px;">Owner Emails (7d): ${sent.length} total</h3>
        <ul style="padding-left:20px;margin:4px 0;">${rowsHtml}</ul>
      `;
    }
  } catch (e) {
    console.log(`[Owner Email Volume] Skipped — ${e.message}`);
  }

  // Overall status banner. Same isActionable filter getDigestSubject() uses
  // (ship-check finding, card #364): without it, the merged email's subject
  // line ("BSC Daily: All clear") could contradict its own site-health block
  // ("2 errors, 1 warning") whenever the only unfixed items are low-urgency
  // playbook entries — exactly the noise the owner asked this merge to kill.
  const isActionableForSnapshot = (r) => {
    const entry = getPlaybookEntry(r.name);
    return !entry || entry.urgency !== 'low';
  };
  const unfixedErrors = errors.filter(r => !autoFixResults?.[r.name]?.fixed && isActionableForSnapshot(r));
  const unfixedWarns = warns.filter(r => !autoFixResults?.[r.name]?.fixed && isActionableForSnapshot(r));
  const overallStatus = unfixedErrors.length > 0 ? 'error' : unfixedWarns.length > 0 ? 'warn' : 'pass';
  const bannerColor = getStatusColor(overallStatus);
  const bannerText = errors.length > 0
    ? `${errors.length} error${errors.length > 1 ? 's' : ''}, ${warns.length} warning${warns.length > 1 ? 's' : ''}`
    : warns.length > 0
    ? `${warns.length} warning${warns.length > 1 ? 's' : ''}`
    : `All ${passed.length} checks passed`;

  const consecutiveInfo = history.consecutiveErrorDays > 0
    ? `<p style="color:#e74c3c;font-size:13px;margin:4px 0;">&#9888;&#65039; Day ${history.consecutiveErrorDays} of consecutive errors</p>`
    : history.lastCleanStreak > 1
    ? `<p style="color:#2ecc71;font-size:13px;margin:4px 0;">&#9989; ${history.lastCleanStreak} day clean streak</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:20px;">
    <!-- Banner -->
    <div style="background:#16213e;border-left:4px solid ${bannerColor};padding:16px 20px;border-radius:8px;margin-bottom:20px;">
      <h2 style="color:${bannerColor};margin:0 0 4px;font-size:18px;">${bannerText}</h2>
      ${consecutiveInfo}
      <p style="color:#666;font-size:12px;margin:4px 0 0;">broadwayscorecard.com &middot; ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
    </div>

    <!-- Health Status Table -->
    <table style="width:100%;border-collapse:collapse;background:#16213e;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="border-bottom:2px solid #333;">
          <th style="padding:8px 12px;text-align:left;color:#888;font-size:12px;text-transform:uppercase;">Category</th>
          <th style="padding:8px 12px;text-align:center;color:#888;font-size:12px;text-transform:uppercase;">Status</th>
        </tr>
      </thead>
      <tbody>${catRows}</tbody>
    </table>

    ${actionHtml}
    ${mezzanineCoverageHtml}
    ${obCandidatesHtml}
    ${workflowHtml}
    ${digestQueueHtml}
    ${ownerEmailHtml}
    ${buildExclusionSummaryHtml()}

    <!-- Footer -->
    <p style="color:#555;font-size:11px;margin-top:24px;text-align:center;">
      Broadway Scorecard Daily Digest &middot; <a href="https://github.com/thomaspryor/Broadwayscore/actions" style="color:#555;">Actions</a>
    </p>
  </div>
</body>
</html>`;

  // Write the snapshot instead of emailing (see the function-level comment
  // above). `html` above is built but no longer sent anywhere — kept for a
  // future debug dump, not wasted: writing it out would bloat a file the
  // owner never opens, so it deliberately does NOT go into the snapshot.
  const autoFixedCount = Object.values(autoFixMap).filter(f => f.fixed).length;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    subject,
    bannerText,
    consecutiveErrorDays: history.consecutiveErrorDays || 0,
    errors: unfixedErrors.map(r => ({ name: r.name, message: r.message })),
    warns: unfixedWarns.map(r => ({ name: r.name, message: r.message })),
    // owner-alert-router's disposition='digest' queue (ship-check finding,
    // card #364): whatever it held only ever reaches the owner if it's
    // carried here. Losing it would silently reintroduce the exact bug card
    // #475 fixed (routed conditions vanishing into a queue nothing reads back
    // out of). The queue is cleared just after this snapshot is written.
    // url is carried too: routeAlert() accepts one and queueDigestLine()
    // persists it, but projecting it away here made renderHealthDigestBlock's
    // link unreachable in production — a digest line whose whole point is
    // "go look at this page" (regional show going live) arrived unclickable.
    queued: queuedDigestItems.map(q => ({ title: q.title, description: q.description, severity: q.severity, url: q.url ?? null })),
    autoFixedCount,
    passedCount: passed.length,
    totalCount: results.length,
  };
  fs.mkdirSync(path.dirname(HEALTH_DIGEST_SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(HEALTH_DIGEST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  // Only now is it safe to clear: the queued lines are durably in the snapshot
  // the morning email reads from. Clearing any earlier (as the old
  // drainDigestQueue() call did) meant a throw anywhere above lost them for
  // good, since the ledger had already marked those conditions notified.
  if (queuedDigestItems.length > 0) clearDigestQueue();
  console.log(`[Health Digest] Snapshot written (${snapshot.errors.length} error(s), ${snapshot.warns.length} warning(s), ${snapshot.queued.length} queued) — folds into the morning email, not sent separately`);
  return true;
}

// --- Triage State (per-system files) ---

function writeTriageState(allResults) {
  fs.mkdirSync(TRIAGE_DIR, { recursive: true });

  // Group results by system category
  const systems = {};
  for (const r of allResults) {
    const category = r.name.split(':')[0].trim().toLowerCase();
    if (!systems[category]) systems[category] = { results: [], worstStatus: 'pass' };
    systems[category].results.push(r);
    if (r.status === 'error') systems[category].worstStatus = 'error';
    else if (r.status === 'warn' && systems[category].worstStatus !== 'error') systems[category].worstStatus = 'warn';
  }

  for (const [system, data] of Object.entries(systems)) {
    const triageFile = path.join(TRIAGE_DIR, `${system}.json`);
    let existing = {};
    try {
      if (fs.existsSync(triageFile)) existing = readJSON(triageFile);
    } catch {}

    const now = new Date().toISOString();
    const state = {
      system,
      status: data.worstStatus,
      lastChecked: now,
      lastAlertTimestamp: existing.lastAlertTimestamp || null,
      autoFixAttempts: data.worstStatus === 'pass' ? 0 : (existing.autoFixAttempts || 0),
      escalationState: data.worstStatus === 'pass' ? 'resolved' : (existing.escalationState || 'monitoring'),
      details: data.results.map(r => ({ name: r.name, status: r.status, message: r.message })),
    };

    fs.writeFileSync(triageFile, JSON.stringify(state, null, 2) + '\n');
  }
}

// --- Auto-Triage Issue Creation ---

async function createTriageIssue(allResults, history) {
  // Only create issues for persistent errors (2+ days)
  if (history.consecutiveErrorDays < 2) return;
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return;

  const errors = allResults.filter(r => r.status === 'error');
  if (errors.length === 0) return;

  // Dedup: check for existing open auto-triage issues
  try {
    const existing = execSync(
      `gh issue list --label auto-triage --state open --json number -q 'length'`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (parseInt(existing, 10) > 0) {
      console.log(`[Triage] ${existing} open auto-triage issue(s) already exist, skipping creation`);
      return;
    }
  } catch {}

  const issueBody = JSON.stringify({
    type: 'health-check-digest',
    timestamp: new Date().toISOString(),
    consecutiveErrorDays: history.consecutiveErrorDays,
    errors: errors.map(e => ({
      name: e.name,
      message: e.message,
      hint: e.hint || null,
      category: e.name.split(':')[0].trim().toLowerCase(),
    })),
  }, null, 2);

  const title = `Auto-Triage: ${errors.length} persistent error${errors.length > 1 ? 's' : ''} (day ${history.consecutiveErrorDays})`;

  try {
    // Write body to temp file to avoid shell escaping issues
    const bodyFile = '/tmp/triage-issue-body.json';
    fs.writeFileSync(bodyFile, issueBody);
    execSync(
      `gh issue create --title "${title}" --label auto-triage --label automated --body-file "${bodyFile}"`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log(`[Triage] Created auto-triage issue: ${title}`);
  } catch (err) {
    console.error(`[Triage] Failed to create issue: ${err.message.substring(0, 100)}`);
  }
}

// --- Progressive Alerting ---

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return readJSON(HISTORY_FILE);
    }
  } catch (e) { /* ignore */ }
  return { lastRun: null, consecutiveErrorDays: 0, results: {} };
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
}

// --- Main ---

// The 22 checks that make up the CORE digest (isCI-gated side effects, plus
// checkDispatchOutcomes' own state-cache write, are opt-out via `dryRun` so
// this same list can be re-run live and read-only by
// scripts/lib/health-row-probe.js — see its header for why check-health-row-
// absent.js can't just re-run scripts/health-check.js wholesale). This is the
// ONLY place the check list is enumerated; main() and the probe both call it
// so the two can never drift apart.
async function computeCoreHealthResults(isCI, { dryRun = false } = {}) {
  return [
    ...checkFreshness(),
    ...checkPushVerification(),
    ...checkOpeningNightHistoryFreshness(),
    ...checkSync(),
    ...checkPipelines(),
    ...checkBatchState(),
    ...checkQuality(),
    ...checkOutletHealth(),
    ...checkCommercialModelDrift(),
    ...checkCookieExpiration(),
    ...checkCWV(),
    ...checkSEO(),
    ...checkCronHealth(),
    ...checkSecretsHealth(),
    ...checkAPICredits(),
    ...checkDeployFreshness(),
    ...(await checkStuckWork()),
    ...(await checkAlertRouterDeadman(isCI)),
    ...checkPushRetryDeadman(),
    ...checkInfraReviewGate(),
    ...checkDispatchOutcomes(dryRun),
    ...checkAutofixEffectiveness(),
    ...checkAutofixCanary(),
    ...checkAutofixThroughput(),
  ];
}

async function main() {
  const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;

  if (!isCI) {
    console.log('⚠️  LOCAL RUN — history/triage/alerts will NOT be updated (stale local data would corrupt CI state)\n');
  }

  console.log('=== Broadway Scorecard Daily Health Check ===\n');

  purgeOldExclusionLogs();

  const allResults = await computeCoreHealthResults(isCI);

  // Workflow run summary (last 24h) \u2014 fetched here, before the alerting block,
  // so repeat failures can be promoted into allResults and escalate like any
  // other check (subject line, consecutive-error days, auto-triage). CI-only:
  // the summary is only ever consumed by the alerting/digest path (which the
  // !isCI early return below skips), and gating the fetch keeps local runs from
  // making live GitHub API calls / burning rate limit on every invocation.
  let workflowSummary = null;
  if (isCI) {
    workflowSummary = await getWorkflowRunSummary();
    if (workflowSummary.skipped) {
      console.log('[Workflows] Skipped \u2014 no GH_TOKEN available');
    } else {
      console.log(`[Workflows] ${workflowSummary.succeeded} succeeded, ${workflowSummary.failed} failed (${workflowSummary.total} total in last 24h)`);
    }
    allResults.push(...repeatFailureResults(workflowSummary));

    const feedbackSummary = await getOpenFeedbackReviewIssues();
    if (!feedbackSummary.skipped) {
      console.log(`[Feedback issues] ${feedbackSummary.issues.length} open needs-manual-review issue(s)`);
    }
    allResults.push(...feedbackBacklogResults(feedbackSummary));

    try {
      const obReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/ob-closing-candidates.json'), 'utf8'));
      allResults.push(...obClosingBacklogResults(obReport));
    } catch { /* report absent (detector not yet run) — nothing to surface */ }

    // Never-run workflow coverage (task #737): computed HERE, not read from a
    // file lint-workflows wrote — that CI job checks out code but has no
    // commit step, so a snapshot written there would never leave the
    // ephemeral runner (ship-check finding). This job already commits
    // data/audit/* daily, so it's the one job that can actually persist the
    // result for the digest to see on the NEXT run and for an operator to
    // inspect directly.
    try {
      const {
        checkNeverRunWorkflowCoverage,
        NEVER_RUN_MIN_AGE_DAYS,
        NEVER_RUN_SNAPSHOT_PATH,
      } = require('./audit-workflow-hygiene.js');
      const workflowDir = path.join(__dirname, '../.github/workflows');
      const workflowFiles = fs
        .readdirSync(workflowDir)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
      const neverRun = await checkNeverRunWorkflowCoverage(workflowFiles);
      if (neverRun.skipped) {
        console.log(`[Workflow coverage] Skipped — ${neverRun.reason}`);
      } else {
        console.log(`[Workflow coverage] ${neverRun.offenders.length} never-run offender(s) among ${neverRun.totalChecked} checked`);
        const neverRunReport = {
          generatedAt: new Date().toISOString(),
          minAgeDays: NEVER_RUN_MIN_AGE_DAYS,
          totalChecked: neverRun.totalChecked,
          offenders: neverRun.offenders,
        };
        fs.mkdirSync(path.dirname(NEVER_RUN_SNAPSHOT_PATH), { recursive: true });
        fs.writeFileSync(NEVER_RUN_SNAPSHOT_PATH, JSON.stringify(neverRunReport, null, 2) + '\n');
        allResults.push(...neverRunWorkflowResults(neverRunReport));
      }
    } catch (err) {
      console.log(`[Workflow coverage] error: ${err.message}`);
    }

    // Disk space on the machine running the local automation. Cheap, no network.
    try {
      const { execSync } = require('child_process');
      const df = execSync(`df -h ${JSON.stringify(path.join(__dirname, '..'))}`, { encoding: 'utf8', timeout: 10000 });
      const { free, total } = readDiskSpace(df);
      allResults.push(...diskSpaceResults(free, total));
    } catch (err) {
      console.log(`[Disk space] error: ${err.message}`);
    }

    try {
      const gapReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/t1-silent-gaps.json'), 'utf8'));
      allResults.push(...silentGapBacklogResults(gapReport));
    } catch { /* report absent (audit not yet run) — nothing to surface */ }

    try {
      const strandReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/uncollected-live-reviews.json'), 'utf8'));
      allResults.push(...uncollectedStrandResults(strandReport));
    } catch { /* report absent (audit not yet run) — nothing to surface */ }

    try {
      const rdReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/reverse-discovery-candidates.json'), 'utf8'));
      allResults.push(...reverseDiscoveryBacklogResults(rdReport));
    } catch { /* report absent (detector not yet run) — nothing to surface */ }

    try {
      const cvReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/card-verifiability.json'), 'utf8'));
      // Drain metric read separately so a missing/!corrupt one still lets the
      // verifiability row through (and vice versa) — one absent report must not
      // silence the other bucket.
      let drainMetric = null;
      try { drainMetric = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/backlog-drain-metric.json'), 'utf8')); } catch { /* drain not yet run */ }
      allResults.push(...cardVerifiabilityBacklogResults(cvReport, drainMetric));
    } catch { /* report absent (audit not yet run) — nothing to surface */ }

    try {
      const progressReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/progress-watch-state.json'), 'utf8'));
      allResults.push(...progressWatchResults(progressReport));
    } catch { /* report absent (monitor not yet run) — nothing to surface */ }

    try {
      const { readRoundupMisses, summarizeBwwRoundupMisses } = require('./lib/bww-roundup-persistence');
      const misses = readRoundupMisses();
      if (misses.length > 0) {
        const { loadShows } = require('./lib/shows-write-guard');
        const { shows } = loadShows();
        allResults.push(...bwwRoundupMissBacklogResults(summarizeBwwRoundupMisses(misses, shows)));
      }
    } catch { /* ledger absent or unreadable — nothing to surface */ }
  }

  // Print console summary
  const icons = { pass: '\u2705', warn: '\u26A0\uFE0F', error: '\u274C' };
  for (const r of allResults) {
    console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
  }

  const totalPassed = allResults.filter(r => r.status === 'pass').length;
  const totalWarn = allResults.filter(r => r.status === 'warn').length;
  const totalError = allResults.filter(r => r.status === 'error').length;

  console.log(`\n--- Summary: ${totalPassed} passed, ${totalWarn} warnings, ${totalError} errors (${allResults.length} total) ---\n`);

  // Local runs: print results only, skip all side effects
  if (!isCI) {
    console.log('ℹ️  Run in CI (data-health-check.yml) for full alerting and triage state updates.');
    return;
  }

  // Progressive alerting (CI only)
  const history = loadHistory();
  const hadErrors = totalError > 0;

  if (hadErrors) {
    history.consecutiveErrorDays = (history.consecutiveErrorDays || 0) + 1;
    history.lastCleanStreak = 0;
  } else {
    history.lastCleanStreak = (history.lastCleanStreak || 0) + 1;
    history.consecutiveErrorDays = 0;
  }
  history.lastRun = new Date().toISOString();
  history.results = allResults.map(r => ({ name: r.name, status: r.status, message: r.message }));
  saveHistory(history);

  // Write per-system triage state files
  writeTriageState(allResults);

  // Auto-fix: attempt to dispatch fix workflows for known issues
  const autoFixResults = {};
  const dispatchedWorkflows = new Set();
  const fixableResults = allResults.filter(r => r.status === 'error' || r.status === 'warn');
  for (const r of fixableResults) {
    const entry = getPlaybookEntry(r.name);
    if (entry && entry.workflow) {
      // Skip if same workflow already dispatched this run (dedup Pipeline vs Freshness)
      if (dispatchedWorkflows.has(entry.workflow)) {
        autoFixResults[r.name] = { fixed: true, workflow: entry.workflow, deduped: true };
        continue;
      }
      const result = await tryAutoFix(r);
      autoFixResults[r.name] = result;
      if (result.fixed) dispatchedWorkflows.add(entry.workflow);
    }
  }
  const autoFixedCount = Object.values(autoFixResults).filter(f => f.fixed).length;
  if (autoFixedCount > 0) {
    console.log(`[Auto-Fix] Fixed ${autoFixedCount} issue(s) automatically`);
  }

  // workflowSummary was fetched earlier (before the alerting block) so repeat
  // failures could be promoted into allResults; reuse it for the digest body.

  // Write the digest snapshot (card #364: no longer emails on its own —
  // autonomous-email.js folds this into the single scheduled morning email).
  // history.lastErrorFingerprint still holds YESTERDAY's error set here —
  // getDigestSubject compares against it to detect "same bad news as yesterday".
  await sendEmailDigest(allResults, history, workflowSummary, autoFixResults);

  // Only after the digest used yesterday's fingerprint: record today's set.
  updateErrorFingerprint(history, allResults, autoFixResults);
  saveHistory(history);

  // Create auto-triage issue for persistent errors
  await createTriageIssue(allResults, history);

  // Exit code: always 0 for expected results (even persistent errors).
  // Email digest handles all daily alerting. notify-failure only fires on actual crashes.
  if (hadErrors && history.consecutiveErrorDays >= 2) {
    console.log(`\n\u274C Persistent errors (${history.consecutiveErrorDays} consecutive days). Reported via email digest.`);
  } else if (hadErrors) {
    console.log(`\n\u26A0\uFE0F First-day errors detected. Monitoring — will escalate if repeated tomorrow.`);
  } else {
    console.log('\u2705 All healthy.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Health check crashed:', err);
    process.exit(1);
  });
}

module.exports = { diskSpaceResults, readDiskSpace, buildObCandidatesHtml, censusRecallResult, coverageProbeResult, getWorkflowRunSummary, repeatFailureResults, isRepeatFailureSelfHealed, feedbackBacklogResults, obClosingBacklogResults, neverRunWorkflowResults, silentGapBacklogResults, uncollectedStrandResults, reverseDiscoveryBacklogResults, cardVerifiabilityBacklogResults, progressWatchResults, bwwRoundupMissBacklogResults, getDigestSubject, getPlaybookEntry, errorSetFingerprint, isEscalationDay, updateErrorFingerprint, sendEmailDigest, HEALTH_DIGEST_SNAPSHOT_FILE, batchStateResult, checkBatchState, checkStuckWork, computeCoreHealthResults };
