#!/usr/bin/env node
/**
 * land-timing-report.js — how long land.yml takes to say yes or no (BRO-7150).
 *
 * On 2026-11-08 a set of small fixes took ~4.5 h to reach main, ~2h40m of it waiting on
 * land.yml: two refusals came only after 31 and 19 minutes, both from cheap repo-wide
 * invariant tests. This report measures the two numbers that matter, from the GitHub API:
 *
 *   time-to-refusal  run start -> the refusing job finished (a land.yml run that failed)
 *   time-to-land     run start -> the Land job finished green (the change is on main)
 *
 * and ranks the refusal causes, read from the failing job's annotations
 * ("<gate>: NEW failure on the branch ...: <file>::<test>", "lint-workflows gate failed: X",
 * "checks RED — first failing gate: X", a failed rebase step, a refused landing).
 *
 * Runs are split into "before" and "after" the fast-fail stage: a run whose Checks job has a
 * step named "Fast-fail ..." (land.yml, BRO-7150) is "after". --split=<ISO time> overrides.
 *
 * Usage: node scripts/lib/land-timing-report.js [--days=7] [--json] [--split=<ISO>] [--repo=owner/name] [--check-targets]
 * --check-targets: exit 1 unless the trailing window meets TARGETS (the BRO-7150 acceptance check).
 * Needs GH_TOKEN or GITHUB_TOKEN (read-only API calls; about 1 + runs + failed runs).
 * Exit: 0 report printed (targets met with --check-targets) | 1 API failure or targets missed | 2 usage
 */
'use strict';

const DEFAULT_REPO = 'thomaspryor/Broadwayscore';
const FAST_STEP_RE = /^Fast-fail\b/;

/** Median of a numeric array (null when empty). */
function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Nearest-rank percentile (p in 0..100) of a numeric array (null when empty). */
function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/**
 * Targets for the trailing window (BRO-7150, chosen from the 2026-11-08 baseline:
 * refusal rate 21.8%, median refusal 24.3 min, median land 27.9 min). The fast-fail
 * step moves time-to-refusal; the pre-push fast tests move the refusal rate; time-to-land
 * of a clean change must not regress (the step costs ~2-3 min on a green branch).
 */
const TARGETS = { maxRefusalRate: 0.12, maxMedianMinutesToRefusal: 8, maxMedianMinutesToLand: 30 };

/** Aggregate -> list of missed targets (empty = met). Too few runs is itself a miss. */
function checkTargets(agg, targets = TARGETS, { minRuns = 20 } = {}) {
  const miss = [];
  if (agg.landed + agg.refused < minRuns) miss.push(`only ${agg.landed + agg.refused} decided runs (< ${minRuns})`);
  if (agg.refusalRate !== null && agg.refusalRate > targets.maxRefusalRate) miss.push(`refusal rate ${(agg.refusalRate * 100).toFixed(1)}% > ${targets.maxRefusalRate * 100}%`);
  if (agg.medianMinutesToRefusal !== null && agg.medianMinutesToRefusal > targets.maxMedianMinutesToRefusal) miss.push(`median time-to-refusal ${agg.medianMinutesToRefusal} min > ${targets.maxMedianMinutesToRefusal}`);
  if (agg.medianMinutesToLand === null || agg.medianMinutesToLand > targets.maxMedianMinutesToLand) miss.push(`median time-to-land ${agg.medianMinutesToLand} min > ${targets.maxMedianMinutesToLand}`);
  return miss;
}

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * One refusal annotation message -> a cause key, or null when the message is not a cause
 * (generic "Process completed with exit code 1", lint warnings, notices).
 */
function causeFromMessage(msg) {
  const m = String(msg || '');
  let r = m.match(/^([\w-]+): NEW failure on the branch[^:]*:\s*(\S+?)::(\S+)/);
  // A sub-check with no file of its own ("lint-workflows::audit-x") is keyed by the sub-check.
  if (r) return /[/.]/.test(r[2]) ? `${r[1]}: ${r[2]}` : `${r[1]}: ${r[3]}`;
  r = m.match(/^([\w-]+): NEW failure on the branch[^:]*:\s*(\S+)/);
  if (r) return `${r[1]}: ${r[2]}`;
  r = m.match(/^lint-workflows gate failed: (\S+)/);
  if (r) return `lint-workflows: ${r[1]}`;
  r = m.match(/^([\w-]+) gate failed: (\S+)/);
  if (r) return `${r[1]}: ${r[2]}`;
  if (/does not rebase cleanly onto/.test(m)) return 'rebase conflict (Checks)';
  r = m.match(/was NOT landed\s*\S+\s*([\w-]+)/);
  if (r) return r[1] === 'rebase' ? 'rebase conflict (at landing)' : `landing refused: ${r[1]}`;
  return null;
}

/** Annotations of a failing job -> sorted unique cause keys (falls back to the first failing gate). */
function causesFromAnnotations(annotations) {
  const failures = (annotations || []).filter((a) => a.annotation_level === 'failure').map((a) => a.message || '');
  const causes = new Set(failures.map(causeFromMessage).filter(Boolean));
  if (!causes.size) {
    for (const f of failures) {
      const g = f.match(/first failing gate: ([\w-]+)/);
      if (g) causes.add(g[1] === 'rebase' ? 'rebase conflict (Checks)' : `${g[1]} (no per-test annotation)`);
    }
  }
  return [...causes].sort();
}

/**
 * A run plus its jobs (and the refusing job's annotations) -> one record:
 * { id, branch, started, outcome: 'landed'|'refused'|'other', minutes, refusedIn, causes, fast }
 * 'other' = cancelled, still running, skipped gauntlet with no Land, superseded.
 */
function summarizeRun(run, jobs, annotations = []) {
  const start = run.run_started_at || run.created_at;
  const byName = (re) => (jobs || []).find((j) => re.test(j.name));
  const checks = byName(/^Checks$/);
  const land = byName(/^Land$/);
  const fast = !!(checks && (checks.steps || []).some((s) => FAST_STEP_RE.test(s.name)));
  const rec = { id: run.id, branch: run.head_branch, started: start, outcome: 'other', minutes: null, refusedIn: null, causes: [], fast };
  if (run.status !== 'completed') return rec;
  if (run.conclusion === 'success' && land && land.conclusion === 'success' && land.completed_at) {
    return { ...rec, outcome: 'landed', minutes: round1(minutes(start, land.completed_at)) };
  }
  if (run.conclusion !== 'failure') return rec;
  // The job that said no: Checks (a red gate, a rebase conflict) or Land (a refused landing).
  const failed = [checks, land].find((j) => j && j.conclusion === 'failure');
  if (!failed || !failed.completed_at) return rec;
  let causes = causesFromAnnotations(annotations);
  const failedStep = (failed.steps || []).find((s) => s.conclusion === 'failure');
  if (!causes.length && failedStep) {
    if (/^Rebase onto/.test(failedStep.name)) causes = ['rebase conflict'];
    else if (FAST_STEP_RE.test(failedStep.name)) causes = ['fast-fail (no per-test annotation)'];
    else causes = [`${failed.name}: step "${failedStep.name}"`];
  }
  if (!causes.length) causes = [`${failed.name}: unknown`];
  return { ...rec, outcome: 'refused', minutes: round1(minutes(start, failed.completed_at)), refusedIn: failed.name, causes };
}

/** Records -> { runs, landed, refused, medianMinutesToLand, medianMinutesToRefusal, causes: [{cause, refusals}] } */
function aggregate(records) {
  const landed = records.filter((r) => r.outcome === 'landed');
  const refused = records.filter((r) => r.outcome === 'refused');
  const counts = new Map();
  for (const r of refused) for (const c of r.causes) counts.set(c, (counts.get(c) || 0) + 1);
  const causes = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([cause, refusals]) => ({ cause, refusals }));
  return {
    runs: records.length,
    landed: landed.length,
    refused: refused.length,
    medianMinutesToLand: round1(median(landed.map((r) => r.minutes))),
    p90MinutesToLand: round1(percentile(landed.map((r) => r.minutes), 90)),
    refusalRate: landed.length + refused.length ? Math.round((refused.length / (landed.length + refused.length)) * 1000) / 1000 : null,
    medianMinutesToRefusal: round1(median(refused.map((r) => r.minutes))),
    refusalsOver10Min: refused.filter((r) => r.minutes > 10).length,
    causes,
  };
}

/** Records -> { all, before, after } split by the fast-fail step (or an explicit ISO time). */
function report(records, { split = null } = {}) {
  const isAfter = split ? (r) => Date.parse(r.started) >= Date.parse(split) : (r) => r.fast;
  return {
    all: aggregate(records),
    before: aggregate(records.filter((r) => !isAfter(r))),
    after: aggregate(records.filter(isAfter)),
  };
}

function parseArgs(argv) {
  const o = { days: 7, json: false, split: null, check: false, repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--days=(\d+(?:\.\d+)?)$/))) o.days = Number(m[1]);
    else if (a === '--json') o.json = true;
    else if (a === '--check-targets') o.check = true;
    else if ((m = a.match(/^--split=(.+)$/)) && Number.isFinite(Date.parse(m[1]))) o.split = m[1];
    else if ((m = a.match(/^--repo=([\w.-]+\/[\w.-]+)$/))) o.repo = m[1];
    else if (a === '-h' || a === '--help') o.help = true;
    else return { error: `unknown or malformed argument: ${a}` };
  }
  if (!(o.days > 0)) return { error: '--days must be positive' };
  return o;
}

/** Map with bounded concurrency. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function collect({ days, repo, api }) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + 'Z';
  const base = `https://api.github.com/repos/${repo}`;
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api(`${base}/actions/workflows/land.yml/runs?per_page=100&page=${page}&created=%3E%3D${since}`);
    const batch = (r && r.workflow_runs) || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return pool(runs, 8, async (run) => {
    const j = await api(`${base}/actions/runs/${run.id}/jobs?per_page=50`);
    const jobs = (j && j.jobs) || [];
    let annotations = [];
    if (run.status === 'completed' && run.conclusion === 'failure') {
      const failed = jobs.find((x) => /^(Checks|Land)$/.test(x.name) && x.conclusion === 'failure');
      if (failed) annotations = (await api(`${base}/check-runs/${failed.id}/annotations?per_page=100`)) || [];
    }
    return summarizeRun(run, jobs, annotations);
  });
}

function printText(rep, { days, split }) {
  const line = (label, a) => `${label.padEnd(7)} runs ${String(a.runs).padStart(4)}  landed ${String(a.landed).padStart(3)} (median ${a.medianMinutesToLand ?? '-'} min, p90 ${a.p90MinutesToLand ?? '-'})  refusal rate ${a.refusalRate === null ? '-' : (a.refusalRate * 100).toFixed(1) + '%'}  refused ${String(a.refused).padStart(3)} (median ${a.medianMinutesToRefusal ?? '-'} min, ${a.refusalsOver10Min} after >10 min)`;
  console.log(`land.yml, last ${days} day(s); before/after split: ${split || 'runs with the Fast-fail step'}`);
  console.log(line('all', rep.all));
  console.log(line('before', rep.before));
  console.log(line('after', rep.after));
  console.log('\nRefusal causes, ranked (all runs):');
  for (const c of rep.all.causes.slice(0, 25)) console.log(`  ${String(c.refusals).padStart(3)}  ${c.cause}`);
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { console.log('usage: land-timing-report.js [--days=7] [--json] [--split=<ISO>] [--repo=owner/name]'); return 0; }
  if (o.error) { console.error(`land-timing-report: ${o.error}`); return 2; }
  const { fetchGitHubJSON } = require('./gh-api-client.js');
  const api = (url) => fetchGitHubJSON(url, { caller: 'land-timing-report.js', timeoutMs: 30000 });
  let records;
  try {
    records = await collect({ days: o.days, repo: o.repo, api });
  } catch (e) {
    console.error(`land-timing-report: GitHub API failed: ${e.message}`);
    return 1;
  }
  const rep = report(records, { split: o.split });
  if (o.json) console.log(JSON.stringify({ days: o.days, split: o.split || 'fast-fail step', targets: TARGETS, ...rep, records }, null, 2));
  else printText(rep, o);
  if (o.check) {
    // Judged on the whole trailing window: by the recheck date every run in it has the fast-fail step.
    const miss = checkTargets(rep.all);
    console.error(miss.length ? `TARGETS MISSED: ${miss.join('; ')}` : `TARGETS MET (${JSON.stringify(TARGETS)})`);
    return miss.length ? 1 : 0;
  }
  return 0;
}

module.exports = { median, percentile, TARGETS, checkTargets, causeFromMessage, causesFromAnnotations, summarizeRun, aggregate, report, parseArgs, FAST_STEP_RE };

if (require.main === module) main().then((code) => { process.exitCode = code; });
