#!/usr/bin/env node
/**
 * github-actions-audit.mjs — estimate paid GitHub Actions spend per repo /
 * workflow / runner type for a month (BRO-8287).
 *
 * Why this exists: the account's billing API needs the `user` OAuth scope,
 * which the CI / headless token does not carry, so spend has to be rebuilt
 * from job timings. GitHub bills each JOB rounded UP to the whole minute,
 * only in PRIVATE repos (public repos are free on standard runners), and
 * never for self-hosted runners. macOS minutes cost ~10x Linux.
 *
 * Usage:
 *   node scripts/github-actions-audit.mjs [--month=2026-11] [--repos=a,b]
 *        [--owner=thomaspryor] [--json]
 *        [--runs-only=repoA,repoB]   treat each run as ONE ubuntu job timed by the run
 *                                    (skips the per-run jobs call; only for repos whose
 *                                    workflows are all single-job Linux)
 *        [--skip-workflows=NAME,...] workflows to leave out (e.g. a self-hosted heartbeat)
 *
 * Exits 0; prints a table (or JSON). Read-only: GETs only via `gh api`.
 */
import { execFileSync } from 'node:child_process';

// USD per billable minute (GitHub-hosted standard runners, private repos).
// Rates per GitHub's Jan-2026 price list; RATE_OVERRIDES env can replace them
// as JSON, e.g. RATE_OVERRIDES='{"linux":0.008}'.
export const RATES = {
  linux: 0.006,
  windows: 0.010,
  macos: 0.062,
  'linux-larger': 0.012,
  'self-hosted': 0,
};

/** Classify a job's runner from its labels (+ runner_name for self-hosted). */
export function runnerClass(job) {
  const labels = (job.labels || []).map((l) => String(l).toLowerCase());
  if (labels.includes('self-hosted')) return 'self-hosted';
  // A job that never got a runner (cancelled in queue) bills nothing.
  if (labels.some((l) => l.startsWith('macos'))) return 'macos';
  if (labels.some((l) => l.startsWith('windows'))) return 'windows';
  if (labels.some((l) => /^ubuntu-.*-(\d+)-core/.test(l) || /-(4|8|16|32|64)-?cores?\b/.test(l))) return 'linux-larger';
  if (labels.some((l) => l.startsWith('ubuntu'))) return 'linux';
  // Self-hosted runners occasionally report custom labels only.
  if (job.runner_group_name && job.runner_group_name !== 'GitHub Actions') return 'self-hosted';
  return 'linux';
}

/** Billable minutes for one job: wall time rounded UP to the minute; 0 if it never started. */
export function billableMinutes(job) {
  if (!job.started_at || !job.completed_at) return 0;
  // Skipped jobs (if: false) report started==completed and no runner.
  if (job.conclusion === 'skipped') return 0;
  const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
  if (!(ms > 0)) return 0;
  return Math.ceil(ms / 60000);
}

/** Cost of one job in USD given repo visibility. */
export function jobCost(job, { isPrivate, rates = RATES }) {
  const cls = runnerClass(job);
  if (cls === 'self-hosted') return 0;
  if (!isPrivate && cls !== 'linux-larger') return 0; // public repo standard runners are free
  return billableMinutes(job) * (rates[cls] ?? rates.linux);
}

/**
 * Aggregate jobs into rows keyed by repo|workflow|runner.
 * jobs: [{repo, isPrivate, workflow, ...githubJob}]
 */
export function aggregate(jobs, rates = RATES) {
  const rows = new Map();
  for (const j of jobs) {
    const cls = runnerClass(j);
    const key = `${j.repo}|${j.workflow}|${cls}`;
    const r = rows.get(key) || { repo: j.repo, workflow: j.workflow, runner: cls, jobs: 0, minutes: 0, usd: 0 };
    r.jobs += 1;
    r.minutes += billableMinutes(j);
    r.usd += jobCost(j, { isPrivate: j.isPrivate, rates });
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd || b.minutes - a.minutes);
}

/**
 * Project end-of-month spend from a known spend-to-date (the billing email)
 * and a daily run rate, with a spike allowance.
 */
export function projectMonthEnd({ spentToDate, asOf, dailyRate, monthEnd, spikeUsd = 0 }) {
  const days = Math.max(0, (Date.parse(monthEnd) - Date.parse(asOf)) / 86400000);
  return +(spentToDate + dailyRate * days + spikeUsd).toFixed(2);
}

/** A run as a single Linux job (for --runs-only repos): timed run_started_at → updated_at. */
export function runAsJob(run) {
  return {
    labels: ['ubuntu-latest'],
    started_at: run.run_started_at,
    completed_at: run.status === 'completed' ? run.updated_at : null,
    conclusion: run.conclusion,
  };
}

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function daysOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let d = 1; d <= n; d++) {
    const s = `${month}-${String(d).padStart(2, '0')}`;
    if (s > today) break;
    out.push(s);
  }
  return out;
}

function fetchRuns(owner, repo, month) {
  const runs = [];
  for (const day of daysOfMonth(month)) {
    for (let page = 1; page <= 10; page++) {
      const res = ghJson(`/repos/${owner}/${repo}/actions/runs?created=${day}&per_page=100&page=${page}`);
      runs.push(...res.workflow_runs);
      if (res.workflow_runs.length < 100) break;
    }
  }
  return runs;
}

function fetchJobs(owner, repo, runId) {
  const jobs = [];
  for (let page = 1; page <= 5; page++) {
    const res = ghJson(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`);
    jobs.push(...res.jobs);
    if (res.jobs.length < 100) break;
  }
  return jobs;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }));
  const owner = args.owner || 'thomaspryor';
  const month = args.month || new Date().toISOString().slice(0, 7);
  const rates = { ...RATES, ...(process.env.RATE_OVERRIDES ? JSON.parse(process.env.RATE_OVERRIDES) : {}) };
  let repos = args.repos ? String(args.repos).split(',') : null;
  const meta = ghJson(`/user/repos?per_page=100&affiliation=owner&sort=pushed`);
  const vis = Object.fromEntries(meta.map((r) => [r.name, r.private]));
  if (!repos) repos = meta.filter((r) => r.private).map((r) => r.name);

  const runsOnly = new Set(args['runs-only'] ? String(args['runs-only']).split(',') : []);
  const skip = new Set(args['skip-workflows'] ? String(args['skip-workflows']).split(',') : []);
  const jobs = [];
  for (const repo of repos) {
    const isPrivate = vis[repo] ?? true;
    const runs = fetchRuns(owner, repo, month);
    process.stderr.write(`${repo}: ${runs.length} runs\n`);
    for (const run of runs) {
      // Runs that never reached a runner bill nothing; skip the jobs call.
      if (!run.run_started_at) continue;
      if (skip.has(run.name)) continue;
      const jobsOfRun = runsOnly.has(repo) ? [runAsJob(run)] : fetchJobs(owner, repo, run.id);
      for (const j of jobsOfRun) {
        jobs.push({ ...j, repo, isPrivate, workflow: run.name, event: run.event, day: run.created_at.slice(0, 10) });
      }
    }
  }
  const rows = aggregate(jobs, rates);
  const byDay = {};
  for (const j of jobs) byDay[j.day] = +((byDay[j.day] || 0) + jobCost(j, { isPrivate: j.isPrivate, rates })).toFixed(3);
  const total = rows.reduce((s, r) => s + r.usd, 0);
  if (args.json) {
    console.log(JSON.stringify({ month, rates, total, rows, byDay }, null, 2));
    return;
  }
  console.log(`Estimated paid Actions spend ${month} (job-rounded minutes x list rate; private repos + larger runners):`);
  for (const r of rows.filter((r) => r.usd > 0 || r.minutes > 30)) {
    console.log(`  $${r.usd.toFixed(2).padStart(7)}  ${String(r.minutes).padStart(6)} min  ${String(r.jobs).padStart(5)} jobs  ${r.runner.padEnd(11)} ${r.repo} / ${r.workflow}`);
  }
  console.log(`  TOTAL est $${total.toFixed(2)}`);
  console.log('  By day:', Object.entries(byDay).map(([d, v]) => `${d.slice(8)}:$${v.toFixed(2)}`).join(' '));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
