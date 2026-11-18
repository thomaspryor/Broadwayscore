'use strict';
/**
 * BRO-7766: a pre-warmed vercel-deploy run (dispatched by rebuild-fast.yml at
 * its start with wait_for_run=<rebuild run id>) does checkout, npm ci, vercel
 * pull, guards and the Next cache restore while the rebuild runs, then waits
 * here until the rebuild has pushed core data. That is the moment the old
 * path dispatched a fresh deploy, so the build starts ~2 min earlier.
 *
 * The signal is the rebuild job's push step (PUSH_STEP below), the step whose
 * success the old "Trigger deploy (core data changed)" step was gated on, so
 * "proceed" here means exactly "the old path would have dispatched a deploy".
 *
 * decide() is pure (unit-tested in tests/unit/deploy-prewarm-wait.test.mjs);
 * main() polls GET /repos/{repo}/actions/runs/{id}/jobs with GITHUB_TOKEN.
 *
 * CLI: node scripts/lib/deploy-prewarm-wait.js <run-id>
 *   exit 0 = proceed (push step succeeded)
 *   exit 10 = do not deploy (push step skipped/failed, job ended without it,
 *             run cancelled)
 *   exit 11 = gave up at the wait cap (API errors or a slow rebuild): the
 *             workflow hands off to a normal deploy
 *
 * CLI: node scripts/lib/deploy-prewarm-wait.js --find-prewarm <rebuild-run-id>
 *   (rebuild-fast.yml's "Trigger deploy" step) prints the id of a pre-warm run
 *   it can rely on, or nothing. Only a run whose WAIT_STEP is in progress and
 *   that is younger than TRUST_MIN counts: it is past setup and will see the
 *   push before its own cap. Any doubt prints nothing, so the caller
 *   dispatches a normal deploy as before (a duplicate deploy is harmless; a
 *   missing one strands the data).
 */

const PUSH_STEP = 'Push core data to private repo';
const REBUILD_JOB = 'Fast rebuild reviews.json';
const POLL_MS = Number(process.env.PREWARM_POLL_MS || 10_000);
// Kept above rebuild-fast's PREWARM_TRUST_MIN (20) so a pre-warm run the
// rebuild skipped its own dispatch for cannot give up before the push lands.
const CAP_MIN = Number(process.env.PREWARM_WAIT_CAP_MIN || 25);
const WAIT_STEP = 'Wait for rebuild';
const DEPLOY_JOB = 'deploy';
const TRUST_MIN = 20;
const prewarmTitle = (rebuildRunId) => `Deploy to Vercel (pre-warm for run ${rebuildRunId})`;

/**
 * @param {Array<{name:string,status:string,conclusion:string|null,steps?:Array<{name:string,status:string,conclusion:string|null}>}>} jobs
 * @returns {{state:'wait'|'proceed'|'skip', reason:string}}
 */
function decide(jobs) {
  const job = (jobs || []).find(j => j && j.name === REBUILD_JOB);
  if (!job) return { state: 'wait', reason: 'rebuild job not started yet' };
  const step = (job.steps || []).find(s => s && s.name === PUSH_STEP);
  if (step && step.status === 'completed') {
    return step.conclusion === 'success'
      ? { state: 'proceed', reason: 'core data pushed' }
      : { state: 'skip', reason: `push step ${step.conclusion || 'ended'}` };
  }
  if (job.status === 'completed') {
    return { state: 'skip', reason: `rebuild job ${job.conclusion || 'ended'} without pushing core data` };
  }
  return { state: 'wait', reason: step ? `push step ${step.status}` : 'push step not reached' };
}

/**
 * @param {{id:number,display_title:string,status:string,created_at:string}} run
 * @param {Array<{name:string,steps?:Array<{name:string,status:string}>}>} jobs
 * @returns {boolean} true when this pre-warm run will ship the rebuild's push
 */
function trustPrewarm(run, jobs, rebuildRunId, nowMs) {
  if (!run || run.display_title !== prewarmTitle(rebuildRunId) || run.status !== 'in_progress') return false;
  const age = nowMs - Date.parse(run.created_at);
  if (!(age >= 0 && age < TRUST_MIN * 60_000)) return false;
  const job = (jobs || []).find(j => j && j.name === DEPLOY_JOB);
  const step = job && (job.steps || []).find(s => s && s.name === WAIT_STEP);
  return !!step && step.status === 'in_progress';
}

async function ghGet(path, token) {
  const res = await fetch(`https://api.github.com/repos/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findPrewarm(repo, rebuildRunId, token) {
  const { workflow_runs: runs = [] } = await ghGet(`${repo}/actions/workflows/vercel-deploy.yml/runs?event=workflow_dispatch&per_page=30`, token);
  for (const run of runs.filter(r => r.display_title === prewarmTitle(rebuildRunId))) {
    const { jobs = [] } = await ghGet(`${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
    if (trustPrewarm(run, jobs, rebuildRunId, Date.now())) return run.id;
  }
  return null;
}

async function fetchJobs(repo, runId, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).jobs || [];
}

async function main() {
  if (process.argv[2] === '--find-prewarm') {
    const rebuildRunId = process.argv[3] || '';
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!/^[0-9]{1,20}$/.test(rebuildRunId) || !repo || !token) { console.error('usage: --find-prewarm <run-id> (needs GITHUB_REPOSITORY, GH_TOKEN)'); process.exit(2); }
    try {
      const id = await findPrewarm(repo, rebuildRunId, token);
      if (id) console.log(id);
    } catch (e) {
      console.error(`[prewarm] lookup failed (${e.message}); caller dispatches a normal deploy`);
    }
    return;
  }
  const runId = process.argv[2] || '';
  if (!/^[0-9]{1,20}$/.test(runId)) { console.error('usage: deploy-prewarm-wait.js <run-id>'); process.exit(2); }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) { console.error('GITHUB_REPOSITORY and GH_TOKEN are required'); process.exit(2); }
  const deadline = Date.now() + CAP_MIN * 60_000;
  let last = '';
  for (;;) {
    let verdict;
    try {
      verdict = decide(await fetchJobs(repo, runId, token));
    } catch (e) {
      verdict = { state: 'wait', reason: `API error (${e.message}), retrying` };
    }
    const line = `${verdict.state}: ${verdict.reason}`;
    if (line !== last) { console.log(`[prewarm] ${new Date().toISOString()} ${line}`); last = line; }
    if (verdict.state === 'proceed') process.exit(0);
    if (verdict.state === 'skip') process.exit(10);
    if (Date.now() >= deadline) { console.log(`[prewarm] gave up after ${CAP_MIN} min`); process.exit(11); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();

module.exports = { decide, trustPrewarm, prewarmTitle, PUSH_STEP, REBUILD_JOB, WAIT_STEP, DEPLOY_JOB, CAP_MIN, TRUST_MIN };
