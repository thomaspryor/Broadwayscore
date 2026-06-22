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
 *   - Email digest: always (daily summary email via Resend — the single source of truth)
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

// --- Auto-Fix Playbook ---
// Maps health check names (regex) to automated fixes or human-readable instructions.
// `workflow`: dispatched automatically via `gh workflow run` (user sees "Auto-fixed").
// `humanAction`: plain-English instruction for non-technical user (no jargon).
// `urgency`: 'fix-now' (red), 'this-week' (yellow), 'low' (gray).

const AUTO_FIX_PLAYBOOK = [
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
  { match: /^Freshness: social-pulse\/_budget\.json$/, urgency: 'this-week', workflow: 'update-social-pulse.yml',
    humanFallback: 'Social Scorecard data is out of date. Runs Mondays — powers /trending pages. Stale >2 weeks means the workflow is failing.' },

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
  { match: /^Quality:/, urgency: 'this-week',
    humanAction: 'The percentage of scored reviews has dropped. Open Claude Code and say: "Check why the scored review percentage dropped and fix it."' },

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

  // API Credits — needs attention if low
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
  { file: 'social-pulse/_budget.json', field: 'lastUpdated', warnH: 192, errorH: 336, hint: 'Check update-social-pulse workflow in Actions tab (runs Monday); powers /trending' },
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
        // Get last successful workflow run time
        const result = execSync(
          `gh run list --workflow="${workflow}" --status=success --limit=1 --json createdAt -q '.[0].createdAt'`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
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
    const openShows = showList.filter(s => s.status === 'open' && (!s.category || s.category === 'broadway'));

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

  // B2b: Per-show social-pulse freshness. The `Freshness: social-pulse/_budget.json`
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
      ((s.category || 'broadway') === 'broadway' || s.category === 'west-end'));
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
      (!s.category || s.category === 'broadway')
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

// --- Category D: Content Quality ---

function checkQuality() {
  return [
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
      // Check for anomalies flagged by the SEO health script
      if (data.anomalies && data.anomalies.length > 0) {
        const critical = data.anomalies.filter(a => a.severity === 'error');
        if (critical.length > 0) {
          return { name: 'SEO: health', status: 'error', message: `${critical.length} critical SEO anomalies: ${critical.map(a => a.metric).join(', ')}`, hint: 'Check data/audit/seo-health.json for details' };
        }
        return { name: 'SEO: health', status: 'warn', message: `${data.anomalies.length} SEO warnings`, hint: 'Check data/audit/seo-health.json for details' };
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
  ];

  return CRITICAL_CRONS.map(({ workflow, maxHours, name }) =>
    runCheck(`Cron: ${name}`, () => {
      try {
        const result = execSync(
          `gh run list --workflow="${workflow}" --limit=1 --json createdAt,conclusion -q '.[0]'`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (!result || result === '{}') {
          return { name: `Cron: ${name}`, status: 'warn', message: 'No runs found' };
        }
        const run = JSON.parse(result);
        const age = hoursAgo(run.createdAt);
        if (age > maxHours) {
          return { name: `Cron: ${name}`, status: 'error', message: `Last run ${formatAge(age)} ago (max ${maxHours}h). Conclusion: ${run.conclusion}`, hint: 'Check Actions tab — workflow may be disabled' };
        }
        if (run.conclusion === 'failure') {
          // Emit under a distinct name so the playbook can route failed-last-run
          // crons to fix-now urgency (prominent in digest), separate from the
          // baseline `Cron: X` staleness checks which stay at low urgency.
          return { name: `Cron failed: ${name}`, status: 'warn', message: `Last run failed (${formatAge(age)} ago)` };
        }
        return { name: `Cron: ${name}`, status: 'pass', message: `${formatAge(age)} ago, ${run.conclusion}` };
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
        const result = execSync(
          `gh run list --workflow="check-secrets-health.yml" --limit=1 --json createdAt,conclusion -q '.[0]'`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (!result || result === '{}') {
          return { name: 'Secrets: health', status: 'warn', message: 'No secrets check runs found' };
        }
        const run = JSON.parse(result);
        const age = hoursAgo(run.createdAt);
        if (age > 336) { // 14 days — weekly check
          return { name: 'Secrets: health', status: 'warn', message: `Last check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-secrets-health workflow manually' };
        }
        if (run.conclusion === 'failure') {
          return { name: 'Secrets: health', status: 'error', message: `Last check FAILED (${formatAge(age)} ago)`, hint: 'Check check-secrets-health workflow logs' };
        }
        return { name: 'Secrets: health', status: 'pass', message: `Last check passed (${formatAge(age)} ago)` };
      } catch (err) {
        return { name: 'Secrets: health', status: 'warn', message: `gh CLI failed: ${err.message.substring(0, 80)}` };
      }
    }),
  ];
}

// --- Category J: API Credits ---

function checkAPICredits() {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    return [{ name: 'Credits: ScrapingBee', status: 'warn', message: 'Skipped — no SCRAPINGBEE_API_KEY available' }];
  }

  const results = [];

  results.push(runCheck('Credits: ScrapingBee', () => {
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

  return results;
}

// --- Category K: Workflow Runs (last 24h summary via GitHub API) ---

async function getWorkflowRunSummary() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const owner = 'thomaspryor';
  const repo = 'Broadwayscore';

  try {
    // Use REST API with per_page=100 (covers most days in 1-2 calls)
    const results = [];
    let page = 1;
    const maxPages = 3; // Cap at 300 runs to avoid rate limit issues

    while (page <= maxPages) {
      const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?created=%3E${since}&per_page=100&page=${page}`;
      const response = await fetchJSON(url, { 'Authorization': `token ${token}`, 'User-Agent': 'bsc-health-check' });
      if (!response || !response.workflow_runs) break;
      results.push(...response.workflow_runs);
      if (response.workflow_runs.length < 100) break;
      page++;
    }

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
function repeatFailureResults(workflowSummary) {
  if (!workflowSummary || workflowSummary.skipped) return [];
  const repeats = workflowSummary.repeatFailures || [];
  return repeats.map(r => ({
    name: `Workflow repeat-failure: ${r.name}`,
    status: r.count >= 3 ? 'error' : 'warn',
    message: `${r.name} failed ${r.count} times in the last 24h — likely broken, not transient.`,
    hint: 'Open the latest run from the Repeat Workflow Failures section of the digest and fix the root cause.',
  }));
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

  if (unfixedErrors.length > 0 && (history.consecutiveErrorDays || 0) >= 5) {
    return `BSC URGENT (day ${history.consecutiveErrorDays}): ${unfixedErrors.length} unresolved error${unfixedErrors.length > 1 ? 's' : ''}`;
  }
  if (unfixedErrors.length >= 3 || (unfixedErrors.length > 0 && (history.consecutiveErrorDays || 0) >= 2)) {
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

async function sendEmailDigest(results, history, workflowSummary, autoFixResults) {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey || !ownerEmail) {
    console.log('[Email Digest] RESEND_API_KEY or OWNER_EMAIL not set, skipping');
    return;
  }

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

      const items = actionable.map(r => {
        const entry = getPlaybookEntry(r.name);
        const urgency = URGENCY_LABELS[r._escalatedUrgency || (entry ? entry.urgency : 'low')] || URGENCY_LABELS['low'];
        const instruction = entry
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
          These workflows failed 2+ times in the last 24 hours. Likely broken, not transient.
        </p>
        <ul style="padding-left:20px;margin:4px 0;">
          ${repeats.map(r => `<li style="color:#e74c3c;margin-bottom:4px;"><strong>${r.name}</strong> — ${r.count} failures — <a href="${r.latestUrl}" style="color:#e74c3c;">latest run</a></li>`).join('')}
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

  // Overall status banner
  const unfixedErrors = errors.filter(r => !autoFixResults?.[r.name]?.fixed);
  const unfixedWarns = warns.filter(r => !autoFixResults?.[r.name]?.fixed);
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
    ${buildExclusionSummaryHtml()}

    <!-- Footer -->
    <p style="color:#555;font-size:11px;margin-top:24px;text-align:center;">
      Broadway Scorecard Daily Digest &middot; <a href="https://github.com/thomaspryor/Broadwayscore/actions" style="color:#555;">Actions</a>
    </p>
  </div>
</body>
</html>`;

  // Send via Resend — throw on failure so health-check exits non-zero
  // (triggers notify-failure → Discord, avoiding bootstrap circularity)
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
      to: [ownerEmail],
      subject,
      html,
    });

    const req = require('https').request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[Email Digest] Daily digest sent successfully');
          resolve(true);
        } else {
          const errMsg = `[Email Digest] Failed: ${res.statusCode} ${body}`;
          console.error(errMsg);
          // Don't throw for rate limits during soak period — just warn
          if (res.statusCode === 429) {
            console.error('[Email Digest] Rate limited — digest not sent');
            resolve(false);
          } else {
            // Don't crash health check for email failures — log and continue
            console.error(errMsg);
            resolve(false);
          }
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Email Digest] Request error:', err.message);
      reject(err);
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('[Email Digest] Request timed out'));
    });

    req.write(data);
    req.end();
  });
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

async function main() {
  const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;

  if (!isCI) {
    console.log('⚠️  LOCAL RUN — history/triage/alerts will NOT be updated (stale local data would corrupt CI state)\n');
  }

  console.log('=== Broadway Scorecard Daily Health Check ===\n');

  purgeOldExclusionLogs();

  const allResults = [
    ...checkFreshness(),
    ...checkPushVerification(),
    ...checkSync(),
    ...checkPipelines(),
    ...checkQuality(),
    ...checkCookieExpiration(),
    ...checkCWV(),
    ...checkSEO(),
    ...checkCronHealth(),
    ...checkSecretsHealth(),
    ...checkAPICredits(),
  ];

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

  // Send email digest (throws on failure → triggers notify-failure)
  await sendEmailDigest(allResults, history, workflowSummary, autoFixResults);

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

module.exports = { buildObCandidatesHtml, repeatFailureResults, getDigestSubject, getPlaybookEntry };
