#!/usr/bin/env node
'use strict';

/**
 * check-cron-fire-rate.js — expected vs actual scheduled fires, plus a sweep of
 * cancelled scheduled runs (BRO-7934).
 *
 *   node scripts/check-cron-fire-rate.js [--days=14] [--workflows=a.yml,b.yml]
 *        [--min-ratio=0.75] [--dry-run] [--json]
 *
 * Scope: every discovery workflow (scripts/lib/discovery-workflows.js) plus every
 * check-cron-health.yml CRITICAL_CRONS entry. Expected fires come from the cron
 * expressions in the workflow file; actual fires are `event=schedule` runs GitHub
 * created (total_count only, one API call per workflow per query). A shortfall
 * routes a digest alert (`cron-fire-rate:<wf>`); cancelled scheduled runs route
 * `cron-cancelled:<wf>` (notify-failure never runs for them: `if: always()` does
 * not fire on cancel). Healthy workflows resolve their condition. The alert is
 * the output channel; exit 0 whenever the check ran, 2 when the API was unusable.
 */

const fs = require('fs');
const { exitFlushed } = require('./lib/exit-flushed');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { extractCrons } = require('./lib/cron-coverage');
const { expectedFireTimes, fireRateVerdict } = require('./lib/cron-fire-rate');
const { DISCOVERY_WORKFLOWS } = require('./lib/discovery-workflows');
const { parseCriticalCronEntries, acceptsRedispatch, redispatchBandHours } = require('./lib/re-dispatcher');

const REPO_ROOT = path.join(__dirname, '..');
const WF_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

function parseArgs(argv) {
  const o = { days: 14, workflows: null, minRatio: 0.75, dryRun: false, json: false, now: Date.now() };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--days=(\d+)$/))) o.days = Number(m[1]);
    else if ((m = a.match(/^--workflows=(.+)$/))) o.workflows = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    else if ((m = a.match(/^--min-ratio=([\d.]+)$/))) o.minRatio = Number(m[1]);
    else if ((m = a.match(/^--now=(.+)$/))) o.now = Date.parse(m[1]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
  }
  return o;
}

function criticalEntries() {
  try {
    return parseCriticalCronEntries(fs.readFileSync(path.join(WF_DIR, 'check-cron-health.yml'), 'utf8'));
  } catch { return []; /* registry unreadable: discovery list alone */ }
}

function scopeWorkflows() {
  return [...new Set([...DISCOVERY_WORKFLOWS, ...criticalEntries().map((e) => e.workflow)])].sort();
}

/** total_count of scheduled runs created in [from, to) with an optional status filter; null = API failed. */
function countRuns(workflow, fromIso, toIso, status, anyEvent = false) {
  const args = ['api', '-X', 'GET', `repos/${REPO}/actions/workflows/${workflow}/runs`,
    ...(anyEvent ? [] : ['-f', 'event=schedule']), '-f', `created=${fromIso}..${toIso}`, '-f', 'per_page=1'];
  if (status) args.push('-f', `status=${status}`);
  try {
    const out = execFileSync('gh', [...args, '--jq', '.total_count'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    console.warn(`  ! gh api failed for ${workflow}: ${(e.message || '').split('\n')[0]}`);
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('usage: node scripts/check-cron-fire-rate.js [--days=14] [--workflows=a.yml,b.yml] [--min-ratio=0.75] [--dry-run] [--json]');
    return 0;
  }
  const args = parseArgs(argv);
  const to = Math.floor(args.now / 60000) * 60000;
  const from = to - args.days * 86400000;
  const fromIso = new Date(from).toISOString().replace(/\.\d+Z$/, 'Z');
  const toIso = new Date(to).toISOString().replace(/\.\d+Z$/, 'Z');
  const files = args.workflows || scopeWorkflows();
  const critical = criticalEntries();

  const rows = [];
  let apiFailures = 0;
  for (const wf of files) {
    const p = path.join(WF_DIR, wf);
    if (!fs.existsSync(p)) { rows.push({ workflow: wf, status: 'workflow-file-missing' }); continue; }
    let crons;
    try { crons = extractCrons(fs.readFileSync(p, 'utf8')); } catch { crons = []; }
    if (!crons.length) { rows.push({ workflow: wf, status: 'not-scheduled' }); continue; }
    let expected;
    try { expected = expectedFireTimes(crons, from, to).length; } catch (e) { rows.push({ workflow: wf, status: `unparseable-cron: ${e.message}` }); continue; }
    // A workflow opted into cron-redispatch is guaranteed one run (any event) per band, not one per
    // cron tick: judge it against that floor, counting the redispatched runs GitHub did create.
    const entry = critical.find((e) => e.workflow === wf);
    const yml = fs.readFileSync(p, 'utf8');
    const covered = !!entry && acceptsRedispatch(yml);
    if (covered) expected = Math.min(expected, Math.floor((args.days * 24) / redispatchBandHours(yml, entry.maxHours)));
    const actual = countRuns(wf, fromIso, toIso, null, covered);
    if (actual === null) { apiFailures++; rows.push({ workflow: wf, status: 'api-unavailable' }); continue; }
    const cancelled = countRuns(wf, fromIso, toIso, 'cancelled');
    rows.push({ ...fireRateVerdict({ workflow: wf, expected, actual, cancelled: cancelled ?? 0, minRatio: covered ? Math.min(args.minRatio, 0.5) : args.minRatio }), crons, redispatchCovered: covered });
  }

  const judged = rows.filter((r) => r.expected !== undefined);
  const short = judged.filter((r) => r.shortfall);
  const canc = judged.filter((r) => r.cancelAlert);
  if (args.json) console.log(JSON.stringify({ from: fromIso, to: toIso, rows }, null, 2));
  else {
    console.log(`Cron fire rate ${fromIso} .. ${toIso} (${args.days}d), ${judged.length} scheduled workflows judged`);
    for (const r of judged.sort((a, b) => (a.ratio ?? 9) - (b.ratio ?? 9))) {
      const pct = r.ratio === null ? 'n/a' : `${Math.round(r.ratio * 100)}%`;
      console.log(`  ${r.shortfall ? 'SHORT ' : r.cancelAlert ? 'CANCEL' : 'ok    '} ${r.workflow.padEnd(44)} fired ${String(r.actual).padStart(5)} / expected ${String(r.expected).padStart(5)} (${pct})  cancelled ${r.cancelled}`);
    }
    for (const r of rows.filter((x) => x.expected === undefined)) console.log(`  skip   ${r.workflow}: ${r.status}`);
    console.log(`${short.length} shortfall(s), ${canc.length} cancelled-run alert(s), ${apiFailures} API failure(s)`);
  }
  if (args.dryRun) return apiFailures && !judged.length ? 2 : 0;

  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  for (const r of judged) {
    const pct = r.ratio === null ? 0 : Math.round(r.ratio * 100);
    const fKey = `cron-fire-rate:${r.workflow}`;
    const cKey = `cron-cancelled:${r.workflow}`;
    if (r.shortfall) {
      await routeAlert({
        conditionKey: fKey, disposition: 'digest', severity: 'error', cooldownHours: 24,
        title: `${r.workflow} is running ${pct}% of the time it should`,
        description: `In the last ${args.days} days GitHub started ${r.actual} scheduled runs of ${r.workflow} where its cron (${r.crons.join(', ')}) calls for ${r.expected}. Reviews this workflow collects arrive late or not at all while it is skipped, and its success-age check still passes because a few runs land.`,
        hint: `Dropped schedules are a GitHub platform behavior (memory feedback_github_cron_delays.md). Fix: opt the workflow into scripts/cron-redispatch.js (a \`redispatched\` workflow_dispatch input plus a check-cron-health.yml CRITICAL_CRONS entry) or add a launchd backup trigger. Re-measure: node scripts/check-cron-fire-rate.js --workflows=${r.workflow} --dry-run`,
        fields: [{ name: 'Fired / expected', value: `${r.actual} / ${r.expected} (${pct}%)` }],
      });
    } else resolveCondition(fKey, { reason: `fire rate ${pct}%` });
    if (r.cancelAlert) {
      await routeAlert({
        conditionKey: cKey, disposition: 'digest', severity: 'error', cooldownHours: 24,
        title: `${r.workflow}: ${r.cancelled} of its ${r.actual} scheduled runs were cancelled`,
        description: `Cancelled runs skip failure notification (\`if: always()\` does not run on cancel), so a workflow killed at its timeout cap or by a concurrency group is silent. ${r.cancelled} of ${r.actual} scheduled runs in the last ${args.days} days were cancelled.`,
        hint: `gh run list --workflow=${r.workflow} --event=schedule --status=cancelled --limit 10. Check timeout-minutes against real duration and the concurrency group's cancel-in-progress.`,
        fields: [{ name: 'Cancelled / scheduled runs', value: `${r.cancelled} / ${r.actual}` }],
      });
    } else resolveCondition(cKey, { reason: 'cancelled share back under threshold' });
  }
  return 0;
}

if (require.main === module) main().then((c) => exitFlushed(c), (e) => { console.error(e); exitFlushed(2); });
module.exports = { parseArgs, scopeWorkflows };
