#!/usr/bin/env node
/**
 * Daily Data Health Check
 *
 * Monitors all automated pipelines for silent failures.
 * 20 checks across 4 categories:
 *   A. Data Freshness (7) — are data files up to date?
 *   B. Data Sync (3) — do derived files match source files?
 *   C. Pipeline Health (6) — did critical workflows run recently? (warn only)
 *   D. Content Quality (1) — is scored review percentage healthy?
 *
 * Progressive alerting:
 *   - #weekly-reports: always (daily summary)
 *   - #alerts: only after 2+ consecutive error days
 *
 * Exit codes: 0 = pass/warn or first-day errors, 1 = persistent errors (2+ days)
 */

const fs = require('fs');
const path = require('path');
const { sendAlert, sendReport, sendToWebhook } = require('./lib/discord-notify');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const PIPELINE_DIR = path.join(AUDIT_DIR, 'pipeline-health');
const HISTORY_FILE = path.join(AUDIT_DIR, 'health-check-history.json');

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
    const openShows = showList.filter(s => s.status === 'open');

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
  const categories = { Freshness: [], Sync: [], Pipelines: [], Quality: [] };
  for (const r of results) {
    if (r.name.startsWith('Freshness:')) categories.Freshness.push(r);
    else if (r.name.startsWith('Sync:')) categories.Sync.push(r);
    else if (r.name.startsWith('Pipeline:')) categories.Pipelines.push(r);
    else if (r.name.startsWith('Quality:')) categories.Quality.push(r);
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
    fields: fields.slice(0, 10),
  }).catch(e => console.error('[Discord] Alert failed:', e.message));
}

// --- Main ---

async function main() {
  console.log('=== Broadway Scorecard Daily Health Check ===\n');

  const allResults = [
    ...checkFreshness(),
    ...checkSync(),
    ...checkPipelines(),
    ...checkQuality(),
  ];

  // Print console summary
  const icons = { pass: '✅', warn: '⚠️', error: '❌' };
  for (const r of allResults) {
    console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
  }

  const totalPassed = allResults.filter(r => r.status === 'pass').length;
  const totalWarn = allResults.filter(r => r.status === 'warn').length;
  const totalError = allResults.filter(r => r.status === 'error').length;

  console.log(`\n--- Summary: ${totalPassed} passed, ${totalWarn} warnings, ${totalError} errors (${allResults.length} total) ---\n`);

  // Progressive alerting
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

  // Send Discord notifications
  await sendDailyReport(allResults, history);
  await sendCriticalAlert(allResults, history);

  // Exit code: 1 only for persistent errors (2+ consecutive days)
  if (hadErrors && history.consecutiveErrorDays >= 2) {
    console.log(`\n❌ Persistent errors (${history.consecutiveErrorDays} consecutive days). Exiting with code 1.`);
    process.exit(1);
  } else if (hadErrors) {
    console.log(`\n⚠️ First-day errors detected. Monitoring — will escalate if repeated tomorrow.`);
  } else {
    console.log('✅ All healthy.');
  }
}

main().catch(err => {
  console.error('Health check crashed:', err);
  process.exit(1);
});
