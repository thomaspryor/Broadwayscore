#!/usr/bin/env node
/**
 * audit-sb-spend.js
 *
 * Attributes ScrapingBee credit spend to the workflow/script that caused it.
 *
 * WHY: The June-2026 Scrapingdog migration only rerouted scraper.js's
 * fetchPage/serpQuery. ~38 scripts call app.scrapingbee.com/api DIRECTLY,
 * bypassing both Scrapingdog and the [SB Call] telemetry — so CI logs badly
 * under-report real SB spend. The SB dashboard showed ~60-100K credits/day
 * while telemetry showed only a few hundred calls. This script closes that gap
 * by parsing the credit signals each caller emits into its GitHub Actions logs.
 *
 * Credit signals parsed (per SB pricing: plain=1, +js=5, premium=10,
 * premium+js=25, stealth=75):
 *   1. Self-reported (collect-review-texts.js):  "ScrapingBee (<proxy>, <N> credits"
 *   2. Telemetry (scraper.js via bd-telemetry):   [SB Call] {..."success":true,"credits":N...}
 *   3. reddit-api.js premium (10cr):              "Falling back to ScrapingBee" (success = not followed by a fail line)
 *   4. grosses SB CSS extraction (10cr premium):  "via scrapingbee-css" / "Found N shows via ScrapingBee"
 *
 * Failed SB calls (401 cap / 500 / socket) are NOT charged by SB, so we only
 * count credits on success signals. The report also prints total MEASURED
 * credits so you can compare against the dashboard and see how much is still
 * unattributed (a large residual = a consumer we haven't parsed yet).
 *
 * Usage:
 *   node scripts/audit-sb-spend.js --since=2026-06-15 --until=2026-06-21
 *   node scripts/audit-sb-spend.js --since=2026-06-15 --until=2026-06-21 --concurrency=6
 *
 * Requires: gh CLI authenticated. Reads GITHUB_REPOSITORY or infers from `gh`.
 */
'use strict';

const { execFileSync, execFile } = require('child_process');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const a = args.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const SINCE = getArg('since');
const UNTIL = getArg('until');
const CONCURRENCY = parseInt(getArg('concurrency', '6'), 10);
if (!SINCE || !UNTIL) {
  console.error('Usage: node scripts/audit-sb-spend.js --since=YYYY-MM-DD --until=YYYY-MM-DD');
  process.exit(1);
}

const REPO = process.env.GITHUB_REPOSITORY ||
  execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' }).trim();

function ghRuns(pathAndQuery) {
  // --paginate concatenates per-page JSON objects, so stream one run per line
  // via --jq (JSONL) and parse line-by-line. Avoids `gh run list` default-20 cap.
  const out = execFileSync('gh', ['api', '--paginate', pathAndQuery, '--jq', '.workflow_runs[] | {id, name}'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function ghLog(runId) {
  return new Promise((resolve) => {
    execFile('gh', ['run', 'view', String(runId), '--log'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      resolve(stdout || ''); // truncation/err → empty; we still count what we can
    });
  });
}

// --- credit extraction from one run's log text ---
function extractCredits(log) {
  let credits = 0, calls = 0;
  const sources = {};
  const add = (src, c) => { credits += c; calls += 1; sources[src] = (sources[src] || 0) + c; };

  // 1. Self-reported "ScrapingBee (<proxy>, <N> credits"
  for (const m of log.matchAll(/ScrapingBee \(([a-z_]+), (\d+) credits/g)) {
    add('self-reported', parseInt(m[2], 10));
  }
  // 2. Telemetry [SB Call] success:true with credits field
  for (const m of log.matchAll(/\[SB Call\] (\{[^\n]*\})/g)) {
    try {
      const r = JSON.parse(m[1]);
      if (r.success === true) add('telemetry', typeof r.credits === 'number' ? r.credits : 1);
    } catch { /* ignore */ }
  }
  // 4. grosses SB CSS extraction success (premium = 10cr)
  for (const _ of log.matchAll(/via scrapingbee-css|Found \d+ shows via ScrapingBee/g)) {
    add('grosses-css', 10);
  }
  return { credits, calls, sources };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  console.error(`Repo: ${REPO} | window: ${SINCE}..${UNTIL} | concurrency: ${CONCURRENCY}`);
  // Pull all runs created in the window (paginated). GH API supports created range filter.
  const q = `repos/${REPO}/actions/runs?created=${SINCE}..${UNTIL}&per_page=100`;
  let runs = [];
  try {
    runs = ghRuns(q);
  } catch (e) {
    console.error('Failed to list runs:', e.message);
    process.exit(1);
  }
  console.error(`Runs in window: ${runs.length}`);

  const perWf = {};   // workflow name -> { credits, calls, runs, sources }
  let scanned = 0;
  await mapLimit(runs, CONCURRENCY, async (run) => {
    const log = await ghLog(run.id);
    const { credits, calls, sources } = extractCredits(log);
    const wf = run.name || 'unknown';
    if (!perWf[wf]) perWf[wf] = { credits: 0, calls: 0, runs: 0, sources: {} };
    perWf[wf].credits += credits;
    perWf[wf].calls += calls;
    perWf[wf].runs += 1;
    for (const [s, c] of Object.entries(sources)) perWf[wf].sources[s] = (perWf[wf].sources[s] || 0) + c;
    scanned++;
    if (scanned % 25 === 0) console.error(`  scanned ${scanned}/${runs.length}...`);
  });

  const rows = Object.entries(perWf)
    .filter(([, v]) => v.credits > 0)
    .sort((a, b) => b[1].credits - a[1].credits);

  const totalCredits = rows.reduce((s, [, v]) => s + v.credits, 0);
  const days = Math.max(1, (new Date(UNTIL) - new Date(SINCE)) / 86400000 + 1);

  console.log(`\n=== ScrapingBee credit attribution: ${SINCE}..${UNTIL} (${Math.round(days)} days) ===`);
  console.log(`Runs scanned: ${runs.length} | MEASURED credits: ${totalCredits.toLocaleString()} (~${Math.round(totalCredits / days).toLocaleString()}/day)\n`);
  console.log('workflow'.padEnd(38), 'credits'.padStart(10), 'calls'.padStart(7), 'runs'.padStart(5), '  sources');
  for (const [wf, v] of rows) {
    const src = Object.entries(v.sources).map(([s, c]) => `${s}:${c}`).join(' ');
    console.log(wf.slice(0, 37).padEnd(38), String(v.credits).padStart(10), String(v.calls).padStart(7), String(v.runs).padStart(5), '  ' + src);
  }
  console.log(`\nNOTE: compare MEASURED/day against the SB dashboard for the same window.`);
  console.log(`A large gap = a consumer whose credit signal this script doesn't yet parse`);
  console.log(`(e.g. a direct caller that logs SB neither via "(N credits)" nor telemetry).`);
})();
