#!/usr/bin/env node
'use strict';
/**
 * Press-night priority (BRO-7198): during a Broadway press-night window, cancel the background runs the go-live-now
 * skill lists as safe, so opening-night work gets runners first. Decision logic: scripts/lib/press-night-priority.js.
 *
 *   node scripts/press-night-priority.js                 dry run: print the plan, cancel nothing
 *   node scripts/press-night-priority.js --apply         cancel the planned runs (needs GITHUB_TOKEN)
 *   --now=ISO            pretend it is this time (simulate a window)
 *   --runs-file=PATH     read runs from a JSON file (array, or {workflow_runs:[...]}) instead of the API
 *   --shows-file=PATH    shows.json (default data/shows.json)
 *   --max=N              cancel at most N runs per call (default 40)
 *
 * Kill switch: PRESS_NIGHT_PRIORITY=off makes it a no-op. The workflow reads the repo variable live every pass and adds
 * --apply only when it is `apply`; anything else is a dry run.
 * Exit 0 always on a plan or a no-op; 1 on a bad argument or an unreadable shows.json.
 */
const fs = require('fs');
const path = require('path');
const { planPriority } = require('./lib/press-night-priority');

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

function readShows(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(d) ? d : d.shows || [];
}

function readRunsFile(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(d) ? d : d.workflow_runs || [];
}

async function api(method, url, token) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000), // one hung request must not stall the loop
  });
  if (method === 'GET' && !res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res;
}

async function fetchActiveRuns(repo, token) {
  const out = [];
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    for (let page = 1; page <= 5; page++) {
      const res = await api('GET', `https://api.github.com/repos/${repo}/actions/runs?status=${status}&per_page=100&page=${page}`, token);
      const body = await res.json();
      const runs = body.workflow_runs || [];
      out.push(...runs);
      if (runs.length < 100) break;
    }
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

const one = (v, n) => String(v || '').replace(/\s+/g, ' ').slice(0, n).padEnd(n); // titles can be multi-line commit messages
const line = (r, reason) => `${r.id}  ${one(r.status, 11)} ${one(r.name, 34)} ${one(r.display_title, 60)} ${reason}`;

async function main() {
  if (String(process.env.PRESS_NIGHT_PRIORITY || '').toLowerCase() === 'off') {
    console.log('press-night priority: PRESS_NIGHT_PRIORITY=off, doing nothing');
    return 0;
  }
  const apply = arg('apply') === true;
  const nowArg = arg('now');
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(nowMs)) { console.error(`press-night priority: bad --now ${nowArg}`); return 1; }
  const max = arg('max') ? Number(arg('max')) : 40;
  if (!Number.isInteger(max) || max < 0) { console.error('press-night priority: bad --max'); return 1; }
  if (apply && arg('runs-file')) { console.error('press-night priority: --apply cannot use --runs-file (fixture runs are not real)'); return 1; }

  const showsFile = arg('shows-file') || path.join(__dirname, '../data/shows.json');
  let shows;
  try { shows = readShows(showsFile); } catch (e) { console.error(`press-night priority: cannot read ${showsFile}: ${e.message}`); return 1; }

  const tonightProbe = planPriority({ shows, runs: [], nowMs });
  if (!tonightProbe.tonight.length) {
    console.log(`press-night priority: no Broadway press-night window at ${new Date(nowMs).toISOString()}; nothing to do`);
    return 0;
  }

  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let runs;
  if (arg('runs-file')) runs = readRunsFile(arg('runs-file'));
  else {
    if (!token) { console.error('press-night priority: GITHUB_TOKEN is not set'); return 1; }
    runs = await fetchActiveRuns(repo, token);
  }
  const selfId = String(process.env.GITHUB_RUN_ID || '');
  runs = runs.filter((r) => String(r.id) !== selfId);

  const plan = planPriority({ shows, runs, nowMs });
  const tonight = plan.tonight.map((t) => `${t.id} (embargo ${t.embargoAt})`).join(', ');
  console.log(`press-night priority ${apply ? 'APPLY' : 'DRY RUN'} at ${new Date(nowMs).toISOString()}; tonight: ${tonight}`);
  console.log(`${runs.length} active run(s): ${plan.cancel.length} to cancel, ${plan.manual.length} safe to cancel by hand only, ${plan.keep.length} kept`);
  for (const { run, reason } of plan.cancel) console.log(`CANCEL ${line(run, reason)}`);
  for (const { run, reason } of plan.manual) console.log(`manual ${line(run, reason)}`);
  for (const { run, reason } of plan.keep) console.log(`keep   ${line(run, reason)}`);

  const summary = [`### Press-night priority (${apply ? 'apply' : 'dry run'})`, '', `Tonight: ${tonight}`, '',
    `${plan.cancel.length} ${apply ? 'cancelled' : 'would be cancelled'}, ${plan.manual.length} safe to cancel by hand only (go-live-now), ${plan.keep.length} kept.`, '',
    ...plan.cancel.map(({ run, reason }) => `- cancel: ${run.display_title || run.name || ''} (${run.id}): ${reason}`),
    ...plan.manual.map(({ run, reason }) => `- by hand: ${run.display_title || run.name || ''} (${run.id}): ${reason}`)];
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');

  if (!apply) return 0;
  let done = 0;
  for (const { run } of plan.cancel.slice(0, max)) {
    const res = await api('POST', `https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`, token);
    // 409 = already finished; anything else is logged and skipped (a cancel never retries).
    console.log(`cancel ${run.id}: HTTP ${res.status}`);
    if (res.status === 202) done++;
  }
  if (plan.cancel.length > max) console.log(`press-night priority: ${plan.cancel.length - max} more left for the next pass (--max=${max})`);
  console.log(`press-night priority: cancelled ${done} run(s)`);
  return 0;
}

if (require.main === module) {
  // An API error never fails the press-night job, but it is a visible warning, not a silent pass.
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.log(`::warning::press-night priority: ${e.message}`); process.exitCode = 0; });
}

module.exports = { main };
