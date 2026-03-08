#!/usr/bin/env node
/**
 * Daily Data Health Check
 *
 * Monitors all automated pipelines for silent failures.
 * Checks across 9 categories:
 *   A. Data Freshness (7) — are data files up to date?
 *   B. Data Sync (3) — do derived files match source files?
 *   C. Pipeline Health (6) — did critical workflows run recently? (warn only)
 *   D. Content Quality (1) — is scored review percentage healthy?
 *   E. Cookie Expiration (1) — are paywall cookies still valid?
 *   F. Core Web Vitals (1) — Lighthouse performance regressions
 *   G. SEO Health (1) — index coverage and traffic anomalies
 *   H. Cron Health (6) — are critical scheduled workflows running?
 *   I. Secrets Health (1) — last check-secrets-health run status
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
const { execSync } = require('child_process');
const { sendAlert, sendReport, sendToWebhook } = require('./lib/discord-notify');

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
  { match: /^Freshness: commercial\.json$/, urgency: 'low', workflow: 'update-commercial.yml',
    humanFallback: 'Commercial data is out of date.' },
  { match: /^Freshness: critic-consensus\.json$/, urgency: 'low', workflow: 'update-critic-consensus.yml',
    humanFallback: 'Critic consensus summaries are out of date.' },
  { match: /^Freshness: lottery-rush\.json$/, urgency: 'low', workflow: 'update-lottery-rush.yml',
    humanFallback: 'Lottery/rush data is out of date.' },

  // Sync — some auto-fixable
  { match: /^Sync: review-texts vs reviews\.json$/, urgency: 'fix-now', workflow: 'rebuild-reviews.yml',
    humanFallback: 'Review database is out of sync with source files.' },
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

  // Cookies — requires human action on Mac
  { match: /^Cookies:/, urgency: 'fix-now',
    humanAction: 'A paywall cookie has expired. On your Mac, open Claude Code and say: "Refresh the expired paywall cookies — check which ones need updating."' },

  // CWV — needs investigation
  { match: /^CWV:/, urgency: 'this-week',
    humanAction: 'Website performance has degraded. Open Claude Code and say: "Check the Core Web Vitals report and fix any performance regressions."' },

  // SEO — needs investigation
  { match: /^SEO:/, urgency: 'this-week',
    humanAction: 'SEO health has degraded. Open Claude Code and say: "Check the SEO health report and fix any issues."' },

  // Cron — the workflows should self-heal, but may need manual dispatch
  { match: /^Cron:/, urgency: 'low',
    humanAction: "A scheduled job hasn't run recently. It'll likely run on its next schedule. If it persists, open Claude Code and say: \"Check why the cron jobs aren't running.\"" },

  // Secrets — needs manual rotation
  { match: /^Secrets:/, urgency: 'fix-now',
    humanAction: 'A secret or API key may be expiring. On your Mac, open Claude Code and say: "Check which secrets need rotation and rotate them."' },
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

  // Guard: max 2 auto-fix attempts per system per day
  const category = checkResult.name.split(':')[0].trim().toLowerCase();
  const triageFile = path.join(TRIAGE_DIR, `${category}.json`);
  try {
    if (fs.existsSync(triageFile)) {
      const triage = readJSON(triageFile);
      if ((triage.autoFixAttempts || 0) >= 2) {
        console.log(`[Auto-Fix] Skipping ${checkResult.name} — already attempted ${triage.autoFixAttempts} times today`);
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

    // Increment auto-fix attempt counter
    try {
      let triage = {};
      if (fs.existsSync(triageFile)) triage = readJSON(triageFile);
      triage.autoFixAttempts = (triage.autoFixAttempts || 0) + 1;
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
  { file: 'shows.json', field: '_meta.lastUpdated', warnH: 48, errorH: 96, hint: 'Check update-show-status workflow in Actions tab' },
  { file: 'grosses.json', field: 'lastUpdated', warnH: 240, errorH: 336, hint: 'Check weekly-grosses workflow in Actions tab' },
  { file: 'audience-buzz.json', field: '_meta.lastUpdated', warnH: 240, errorH: 336, hint: 'Check audience buzz workflows in Actions tab' },
  { file: 'commercial.json', field: '_meta.lastUpdated', warnH: 336, errorH: 504, hint: 'Check update-commercial workflow in Actions tab' },
  { file: 'critic-consensus.json', field: '_meta.lastGenerated', warnH: 336, errorH: 504, hint: 'Check update-critic-consensus workflow in Actions tab' },
  { file: 'lottery-rush.json', field: 'lastUpdated', warnH: 336, errorH: 504, hint: 'Check update-lottery-rush workflow in Actions tab' },
];

function checkFreshness() {
  return FRESHNESS_CHECKS.map(({ file, field, warnH, errorH, hint }) =>
    runCheck(`Freshness: ${file}`, () => {
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

  // B3: Baseline drift
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
  if (!fs.existsSync(COOKIE_DIR)) {
    results.push({ name: 'Cookies: expiration', status: 'warn', message: 'data/cookies/ not found', hint: 'Run: python3 scripts/extract-safari-cookies.py' });
    return results;
  }

  const files = fs.readdirSync(COOKIE_DIR).filter(f => f.endsWith('.json'));
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

    results.push({
      name: 'Cookies: expiration',
      status,
      message: `${expired} expired, ${expiring} expiring <${COOKIE_WARN_DAYS}d — ${summary}`,
      hint: 'Run: python3 scripts/extract-safari-cookies.py then gh secret set <NAME> < /tmp/<file>.txt',
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
      // CI runners are ~30-50% slower than real devices; thresholds account for this
      if (m.lcp > 5000) alerts.push(`Mobile LCP ${(m.lcp / 1000).toFixed(1)}s`);
      if (m.cls > 0.1) alerts.push(`Mobile CLS ${m.cls.toFixed(3)}`);
      if (m.tbt > 750) alerts.push(`Mobile TBT ${m.tbt.toFixed(0)}ms`);
      if (d.lcp > 2500) alerts.push(`Desktop LCP ${(d.lcp / 1000).toFixed(1)}s`);
      if (d.cls > 0.1) alerts.push(`Desktop CLS ${d.cls.toFixed(3)}`);
      if (d.tbt > 300) alerts.push(`Desktop TBT ${d.tbt.toFixed(0)}ms`);

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
      const age = data.timestamp ? hoursAgo(data.timestamp) : Infinity;
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
      // Check index coverage
      if (data.indexCoverage) {
        const { indexed, total } = data.indexCoverage;
        if (total > 0 && indexed / total < 0.9) {
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

  const CRITICAL_CRONS = [
    { workflow: 'update-show-status.yml', maxHours: 36, name: 'Update Show Status' },
    { workflow: 'rebuild-reviews.yml', maxHours: 36, name: 'Rebuild Reviews' },
    { workflow: 'collect-review-texts.yml', maxHours: 36, name: 'Collect Review Texts' },
    { workflow: 'llm-ensemble-score.yml', maxHours: 48, name: 'LLM Ensemble Score' },
    { workflow: 'test.yml', maxHours: 48, name: 'Test Suite' },
    { workflow: 'opening-night-broadcast.yml', maxHours: 36, name: 'Opening Night Broadcast' },
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
          return { name: `Cron: ${name}`, status: 'warn', message: `Last run failed (${formatAge(age)} ago)` };
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

// --- Category J: Workflow Runs (last 24h summary via GitHub API) ---

async function getWorkflowRunSummary() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], skipped: true };
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

    return {
      total: completed.length,
      failed: failed.length,
      succeeded: completed.filter(r => r.conclusion === 'success').length,
      failedRuns: failed.slice(0, 5).map(r => ({
        name: r.name,
        url: r.html_url,
        created: r.created_at,
      })),
      skipped: false,
    };
  } catch (err) {
    console.error(`[Workflows] API error: ${err.message}`);
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], skipped: true, error: err.message };
  }
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
        const urgencyLevel = entry ? entry.urgency : 'low';
        if (urgencyLevel === 'low') {
          lowCount.count++;
        } else {
          actionable.push(r);
        }
      }

      const items = actionable.map(r => {
        const entry = getPlaybookEntry(r.name);
        const urgency = entry ? URGENCY_LABELS[entry.urgency] || URGENCY_LABELS['low'] : URGENCY_LABELS['low'];
        const instruction = entry
          ? (entry.humanAction || entry.humanFallback || r.message)
          : r.message;
        const fix = autoFixMap[r.name];
        const failNote = fix && fix.message
          ? `<br><span style="color:#e74c3c;font-size:11px;">Auto-fix failed: ${fix.message}</span>`
          : '';

        return `<div style="padding:10px 12px;margin-bottom:8px;background:#2a1a1a;border-left:3px solid ${urgency.bg};border-radius:4px;">
          <span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${urgency.bg};color:${urgency.color};font-size:11px;font-weight:bold;">${urgency.label}</span>
          <span style="color:#ddd;margin-left:8px;font-weight:bold;">${r.name.split(': ').pop()}</span>
          <p style="color:#bbb;margin:6px 0 0;font-size:13px;line-height:1.4;">${instruction}</p>
          ${failNote}
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

  // Workflow runs section
  let workflowHtml = '';
  if (workflowSummary && !workflowSummary.skipped) {
    const failedList = workflowSummary.failedRuns.length > 0
      ? workflowSummary.failedRuns.map(r => `<li style="color:#e74c3c;margin-bottom:4px;"><a href="${r.url}" style="color:#e74c3c;">${r.name}</a></li>`).join('')
      : '';
    workflowHtml = `
      <h3 style="color:#aaa;margin:24px 0 8px;">Workflow Runs (24h)</h3>
      <p style="color:#ccc;margin:4px 0;">
        ${workflowSummary.succeeded} succeeded, ${workflowSummary.failed} failed (${workflowSummary.total} total)
      </p>
      ${failedList ? `<ul style="padding-left:20px;margin:4px 0;">${failedList}</ul>` : ''}
    `;
  }

  // Overall status banner
  const overallStatus = errors.length > 0 ? 'error' : warns.length > 0 ? 'warn' : 'pass';
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
    ${workflowHtml}

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
            reject(new Error(errMsg));
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

// --- Discord Notifications ---

async function sendDailyReport(results, history) {
  const categories = { Freshness: [], Sync: [], Pipelines: [], Quality: [], Cookies: [], CWV: [], SEO: [], Cron: [], Secrets: [] };
  for (const r of results) {
    if (r.name.startsWith('Freshness:')) categories.Freshness.push(r);
    else if (r.name.startsWith('Sync:')) categories.Sync.push(r);
    else if (r.name.startsWith('Pipeline:')) categories.Pipelines.push(r);
    else if (r.name.startsWith('Quality:')) categories.Quality.push(r);
    else if (r.name.startsWith('Cookies:')) categories.Cookies.push(r);
    else if (r.name.startsWith('CWV:')) categories.CWV.push(r);
    else if (r.name.startsWith('SEO:')) categories.SEO.push(r);
    else if (r.name.startsWith('Cron:')) categories.Cron.push(r);
    else if (r.name.startsWith('Secrets:')) categories.Secrets.push(r);
  }

  const catSummary = (checks) => {
    const passed = checks.filter(c => c.status === 'pass').length;
    const total = checks.length;
    const icon = passed === total ? ':white_check_mark:' : ':warning:';
    return `${icon} ${passed}/${total}`;
  };

  const totalPassed = results.filter(r => r.status === 'pass').length;
  const totalWarn = results.filter(r => r.status === 'warn').length;
  const totalError = results.filter(r => r.status === 'error').length;
  const total = results.length;

  let title, severity;
  if (totalError > 0) {
    title = `Daily Health Check — ${totalError} Error${totalError > 1 ? 's' : ''}`;
    severity = history.consecutiveErrorDays >= 2 ? 'error' : 'warning';
  } else if (totalWarn > 0) {
    title = `Daily Health Check — ${totalWarn} Warning${totalWarn > 1 ? 's' : ''}`;
    severity = 'warning';
  } else {
    title = 'Daily Health Check — All Clear';
    severity = 'success';
  }

  // Build description with failed check details
  let description = `${totalPassed}/${total} checks passed`;
  const failures = results.filter(r => r.status !== 'pass');
  if (failures.length > 0) {
    const top5 = failures.slice(0, 5);
    description += '\n\n' + top5.map(f => {
      const icon = f.status === 'error' ? ':x:' : ':warning:';
      return `${icon} **${f.name}**: ${f.message}`;
    }).join('\n');
    if (failures.length > 5) {
      description += `\n...and ${failures.length - 5} more`;
    }
  }

  const fields = [
    { name: 'Freshness', value: catSummary(categories.Freshness), inline: true },
    { name: 'Sync', value: catSummary(categories.Sync), inline: true },
    { name: 'Pipelines', value: catSummary(categories.Pipelines), inline: true },
    { name: 'Quality', value: catSummary(categories.Quality), inline: true },
    { name: 'Cookies', value: catSummary(categories.Cookies), inline: true },
    { name: 'CWV', value: catSummary(categories.CWV), inline: true },
    { name: 'SEO', value: catSummary(categories.SEO), inline: true },
    { name: 'Cron', value: catSummary(categories.Cron), inline: true },
    { name: 'Secrets', value: catSummary(categories.Secrets), inline: true },
  ];

  const webhookUrl = process.env.DISCORD_WEBHOOK_REPORTS;
  if (!webhookUrl) {
    console.log('[Discord] DISCORD_WEBHOOK_REPORTS not set, skipping report');
    return;
  }

  const COLORS = { success: 0x2ecc71, warning: 0xf39c12, error: 0xe74c3c };

  await sendToWebhook(webhookUrl, {
    username: 'Broadway Scorecard',
    embeds: [{
      title: `${severity === 'success' ? ':white_check_mark:' : severity === 'error' ? ':x:' : ':warning:'} ${title}`,
      description,
      color: COLORS[severity],
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `Consecutive clean days: ${history.consecutiveErrorDays === 0 ? (history.lastCleanStreak || 0) : 0}` },
    }],
  }).catch(e => console.error('[Discord] Report failed:', e.message));
}

async function sendCriticalAlert(results, history) {
  const errors = results.filter(r => r.status === 'error');
  if (errors.length === 0 || history.consecutiveErrorDays < 2) return;

  const fields = errors.map(e => ({
    name: e.name,
    value: `${e.message}${e.hint ? `\n→ ${e.hint}` : ''}`,
    inline: false,
  }));

  await sendAlert({
    title: `Data Health Check — Day ${history.consecutiveErrorDays} of Failures`,
    description: `${errors.length} error-level check${errors.length > 1 ? 's' : ''} failing for ${history.consecutiveErrorDays} consecutive days.`,
    severity: 'error',
    email: true,
    fields: fields.slice(0, 10),
  }).catch(e => console.error('[Discord] Alert failed:', e.message));
}

// --- Main ---

async function main() {
  const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;

  if (!isCI) {
    console.log('⚠️  LOCAL RUN — history/triage/alerts will NOT be updated (stale local data would corrupt CI state)\n');
  }

  console.log('=== Broadway Scorecard Daily Health Check ===\n');

  const allResults = [
    ...checkFreshness(),
    ...checkSync(),
    ...checkPipelines(),
    ...checkQuality(),
    ...checkCookieExpiration(),
    ...checkCWV(),
    ...checkSEO(),
    ...checkCronHealth(),
    ...checkSecretsHealth(),
  ];

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
  const fixableResults = allResults.filter(r => r.status === 'error' || r.status === 'warn');
  for (const r of fixableResults) {
    const entry = getPlaybookEntry(r.name);
    if (entry && entry.workflow) {
      autoFixResults[r.name] = await tryAutoFix(r);
    }
  }
  const autoFixedCount = Object.values(autoFixResults).filter(f => f.fixed).length;
  if (autoFixedCount > 0) {
    console.log(`[Auto-Fix] Fixed ${autoFixedCount} issue(s) automatically`);
  }

  // Get workflow run summary for the digest
  const workflowSummary = await getWorkflowRunSummary();
  if (workflowSummary.skipped) {
    console.log('[Workflows] Skipped — no GH_TOKEN available');
  } else {
    console.log(`[Workflows] ${workflowSummary.succeeded} succeeded, ${workflowSummary.failed} failed (${workflowSummary.total} total in last 24h)`);
  }

  // Email digest disabled — replaced by BSC Daily action email (see daily-action-email.yml)
  // Discord notifications still fire below for monitoring
  // await sendEmailDigest(allResults, history, workflowSummary, autoFixResults);

  // Send Discord notifications
  await sendDailyReport(allResults, history);
  await sendCriticalAlert(allResults, history);

  // Create auto-triage issue for persistent errors
  await createTriageIssue(allResults, history);

  // Exit code: 1 only for persistent errors (2+ consecutive days)
  if (hadErrors && history.consecutiveErrorDays >= 2) {
    console.log(`\n\u274C Persistent errors (${history.consecutiveErrorDays} consecutive days). Exiting with code 1.`);
    process.exit(1);
  } else if (hadErrors) {
    console.log(`\n\u26A0\uFE0F First-day errors detected. Monitoring — will escalate if repeated tomorrow.`);
  } else {
    console.log('\u2705 All healthy.');
  }
}

main().catch(err => {
  console.error('Health check crashed:', err);
  process.exit(1);
});
