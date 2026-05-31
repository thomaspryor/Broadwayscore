#!/usr/bin/env node
/**
 * Analyze Bright Data per-call telemetry from GitHub Actions logs.
 *
 * Scans the last 7 days of completed workflow runs, extracts every
 * `[BD Call] {json}` line, and prints top-5 tables by script / host /
 * fn / workflow. Also flags the SERP-api→serp-unlocker waterfall rate
 * (high rate = paying double for one query).
 *
 * Saves snapshot to data/audit/bd-telemetry-analysis.json.
 *
 * Requirements: gh CLI authenticated, run from repo root.
 * Usage: node scripts/analyze-bd-telemetry.js [--days=N] [--max-runs=N]
 */

'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- CLI args ---------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const DAYS = parseInt(args['days'] || '7', 10);
const MAX_RUNS = parseInt(args['max-runs'] || '500', 10);
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

// ---- helpers ----------------------------------------------------------------
function ghJson(cmd) {
  try {
    return JSON.parse(execSync(`gh ${cmd}`, { maxBuffer: 50 * 1024 * 1024, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString());
  } catch (e) {
    if (e.message?.includes('command not found') || e.message?.includes('gh: not found')) {
      throw new Error('gh CLI not found — run this script locally or in a GitHub Actions job that has gh installed');
    }
    return null;
  }
}

function sinceIso(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10) + 'T00:00:00Z';
}

function top5(map, label) {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxVal = sorted[0]?.[1] || 1;
  const rows = sorted.map(([k, v]) => {
    const bar = '█'.repeat(Math.round(v / maxVal * 20)).padEnd(20, '░');
    return `  ${String(v).padStart(5)}  ${bar}  ${k}`;
  });
  return [`Top 5 by ${label}:`, ...rows, ''].join('\n');
}

// ---- fetch run IDs ----------------------------------------------------------
console.log(`Scanning last ${DAYS} days of GitHub Actions logs in ${REPO}...`);
const since = sinceIso(DAYS);

let runIds = [];
let page = 1;
while (runIds.length < MAX_RUNS) {
  const data = ghJson(`api "repos/${REPO}/actions/runs?created=>=${since}&status=completed&per_page=100&page=${page}"`);
  if (!data || !data.workflow_runs?.length) break;
  runIds.push(...data.workflow_runs.map(r => ({ id: r.id, workflow: r.name })));
  if (data.workflow_runs.length < 100) break;
  page++;
  if (page > 10) break; // hard cap
}
console.log(`Found ${runIds.length} completed runs since ${since}`);

if (runIds.length === 0) {
  console.log('No runs found — either gh CLI is not authenticated or no runs in window.');
  process.exit(0);
}

// ---- parse logs for BD calls ------------------------------------------------
const byScript   = new Map();
const byHost     = new Map();
const byFn       = new Map();
const byWorkflow = new Map();
let totalCalls = 0;
let successCount = 0;
let fallbackCount = 0;
let runsWithData = 0;
let runsChecked = 0;
const sampleRecords = [];

for (const { id, workflow } of runIds) {
  runsChecked++;
  if (runsChecked % 50 === 0) process.stderr.write(`  checked ${runsChecked}/${runIds.length} runs, ${totalCalls} BD calls so far\n`);

  let logOutput;
  try {
    logOutput = execSync(`gh run view ${id} --log 2>/dev/null`, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();
  } catch { continue; }

  const lines = logOutput.split('\n').filter(l => l.includes('[BD Call]'));
  if (lines.length === 0) continue;
  runsWithData++;

  for (const line of lines) {
    const idx = line.indexOf('[BD Call] ');
    if (idx === -1) continue;
    try {
      const rec = JSON.parse(line.slice(idx + '[BD Call] '.length).trim());
      totalCalls++;
      if (rec.success) successCount++;
      if (rec.fallback_from) fallbackCount++;

      const script = rec.script || 'unknown';
      const host   = rec.host   || 'unknown';
      const fn     = rec.fn     || 'unknown';
      const wf     = rec.workflow || workflow || 'unknown';

      byScript.set(script, (byScript.get(script) || 0) + 1);
      byHost.set(host,     (byHost.get(host)     || 0) + 1);
      byFn.set(fn,         (byFn.get(fn)         || 0) + 1);
      byWorkflow.set(wf,   (byWorkflow.get(wf)   || 0) + 1);

      if (sampleRecords.length < 100) sampleRecords.push(rec);
    } catch { /* malformed line */ }
  }
}

// ---- report -----------------------------------------------------------------
console.log('\n══════════════════════════════════════════════');
console.log(`BD TELEMETRY ANALYSIS — last ${DAYS} days`);
console.log(`══════════════════════════════════════════════`);
console.log(`Runs checked   : ${runsChecked}`);
console.log(`Runs with data : ${runsWithData}`);
console.log(`Total BD calls : ${totalCalls}`);

if (totalCalls < 100) {
  console.log('\n⚠️  SPARSE DATA: fewer than 100 calls found. Possible causes:');
  console.log('  1. collect-review-texts.js has its own fetchWithBrightData that bypasses telemetry');
  console.log('  2. Telemetry was not yet wired on some workflows');
  console.log('  3. Logs for most runs have expired (>90 days old)');
  console.log('\nDo NOT over-interpret these numbers.');
} else {
  console.log(`Success rate   : ${totalCalls > 0 ? ((successCount/totalCalls)*100).toFixed(1) : 'n/a'}%`);
  console.log(`SERP waterfall : ${fallbackCount} calls had fallback_from set (${totalCalls > 0 ? ((fallbackCount/totalCalls)*100).toFixed(1) : 0}%)`);
  if (fallbackCount / totalCalls > 0.15) {
    console.log('  ⚠️  >15% waterfall rate — SERP-api calls are failing frequently, paying double per query');
  }
}

console.log('');
console.log(top5(byScript,   'script'));
console.log(top5(byHost,     'host'));
console.log(top5(byFn,       'function (web-unlocker / serp-api / serp-unlocker)'));
console.log(top5(byWorkflow, 'workflow'));

// ---- known gap warning ------------------------------------------------------
const crtInTop = [...byScript.keys()].some(s => s.includes('collect-review-texts'));
if (!crtInTop && totalCalls > 0) {
  console.log('⚠️  GAP: collect-review-texts.js is NOT in the telemetry data.');
  console.log('   This script has its own fetchWithBrightData (line 2416) that bypasses recordBdCall.');
  console.log('   All BD calls from collect-review-texts.js are INVISIBLE here.');
  console.log('   The cuts in bd-cost-phase2 branch wire telemetry to it — push that branch to fix.');
}

// ---- cost estimate ($0.0015/req web-unlocker, $0.004/req SERP) --------------
if (totalCalls > 0) {
  const unlockerCalls = (byFn.get('web-unlocker') || 0);
  const serpCalls = (byFn.get('serp-api') || 0) + (byFn.get('serp-unlocker') || 0);
  const estimatedCost = (unlockerCalls * 0.0015 + serpCalls * 0.004).toFixed(2);
  const dailyRate = (parseFloat(estimatedCost) / DAYS).toFixed(2);
  console.log(`\nCost estimate (${DAYS}d): $${estimatedCost} → ~$${dailyRate}/day → ~$${(parseFloat(dailyRate)*30).toFixed(0)}/mo`);
  console.log('(BD pricing: Web Unlocker $0.0015/req, SERP $0.004/req)');
  console.log('Note: collect-review-texts.js BD calls are missing — actual cost higher.');
}

// ---- save snapshot ----------------------------------------------------------
const auditDir = path.join('data', 'audit');
if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });

const snapshot = {
  generatedAt: new Date().toISOString(),
  windowDays: DAYS,
  runsChecked,
  runsWithData,
  totalCalls,
  successRate: totalCalls > 0 ? successCount / totalCalls : null,
  serpWaterfallRate: totalCalls > 0 ? fallbackCount / totalCalls : null,
  byScript:   Object.fromEntries([...byScript.entries()].sort((a, b) => b[1] - a[1])),
  byHost:     Object.fromEntries([...byHost.entries()].sort((a, b)   => b[1] - a[1])),
  byFn:       Object.fromEntries([...byFn.entries()].sort((a, b)     => b[1] - a[1])),
  byWorkflow: Object.fromEntries([...byWorkflow.entries()].sort((a, b) => b[1] - a[1])),
  knownGaps: !crtInTop ? ['collect-review-texts.js bypasses recordBdCall — its BD calls are invisible'] : [],
};

fs.writeFileSync(path.join(auditDir, 'bd-telemetry-analysis.json'), JSON.stringify(snapshot, null, 2));
console.log('\nSnapshot saved → data/audit/bd-telemetry-analysis.json');
