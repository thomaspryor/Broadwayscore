#!/usr/bin/env node
'use strict';

/**
 * land-retry-cancelled.js — re-run Land jobs that were only queue casualties
 * of the shared `landing` slot (BRO-4246), spending an attempt only while the
 * slot is free (BRO-4653) or held by one running job with nobody pending
 * (BRO-4677). Run by land-retry-cancelled.yml.
 *
 *   node scripts/land-retry-cancelled.js --sweep [--dry-run]
 *     Slot free, or held by a running job with the pending seat empty →
 *     re-run at most ONE stranded cancelled Land run, oldest first. Pending
 *     seat taken → wait, except a run stranded >30 min is
 *     re-run anyway (BRO-4676 aging; still one re-run per sweep).
 *   node scripts/land-retry-cancelled.js --run=<id> [--dry-run]
 *     Targeted retry of one run, same slot rule.
 *   node scripts/land-retry-cancelled.js --stranded [--only=<land/branch>] [--dry-run]
 *     Hourly pass over every land/** ref still on origin (BRO-4802): a ref
 *     evicted outside the fast-retry window gets a FULL re-run (Checks again
 *     on today's main), spaced an hour apart; a refused, red or budget-spent
 *     ref is routed to the card it names (comment with resume steps, card
 *     back to Todo). Decisions: scripts/lib/land-stranded-refs.js.
 *
 * Decisions: scripts/lib/land-retry-on-cancel.js (is this run a queue
 * casualty?) and scripts/lib/land-queue-backoff.js (is the slot free, which
 * run goes next?).
 */

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { decideLandRetry, runGhWithFallback, isRefNotFound, decideCancelledWait } = require('./lib/land-retry-on-cancel');
const {
  slotQueries, scanSlot, supersededByNewerRun, decideSweep, landJobInSlot, MAX_AGE_HOURS, MAX_JOB_LOOKUPS,
} = require('./lib/land-queue-backoff');

const USAGE = 'usage: node scripts/land-retry-cancelled.js --sweep | --run=<id> | --stranded [--only=<land/branch>] [--dry-run]';
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const runId = arg('run');
const only = arg('only');
const sweep = process.argv.includes('--sweep');
const stranded = process.argv.includes('--stranded');
const dry = process.argv.includes('--dry-run');
if ([sweep, Boolean(runId), stranded].filter(Boolean).length !== 1 || (runId && !/^\d+$/.test(runId))) { console.error(USAGE); process.exit(2); }

const ghRaw = (args) => runGhWithFallback(args, { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN });
const gh = (args) => JSON.parse(ghRaw(args));
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

// Memoized: the slot scan, rerunInFlight and the decisions can ask about the same run.
const jobsCache = new Map();
const jobsOf = (id) => {
  if (!jobsCache.has(String(id))) jobsCache.set(String(id), gh([`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=50`]).jobs);
  return jobsCache.get(String(id));
};

// Status-filtered listings (not a created-desc page: re-runs keep their
// original created_at), all gathered first, then checked likeliest holder
// first. A land.yml run costs one jobs lookup to tell "in Checks" (clear) from
// "Land job running or pending" (busy). Anything unknown reads as busy.
function slotState(selfRunId) {
  const byId = new Map();
  for (const q of slotQueries(repo)) {
    const page = gh([q]);
    const runs = page.workflow_runs || [];
    for (const run of runs) byId.set(run.id, run);
    if ((page.total_count || 0) > runs.length) return { busy: true, rerunInFlight: true, blockers: [{ id: '-', branch: q, status: 'unlisted', why: 'too-many-in-flight' }] };
  }
  // BRO-4676: a land.yml re-run still in flight (pending or running) must finish
  // before another aged re-run is allowed to compete for the slot.
  // BRO-4802: only once its Land job holds or waits for the slot. A FULL re-run
  // (the --stranded pass) spends ~30 min in Checks first, and counting that
  // would stall every fast and aged retry for the whole time. A fast re-run
  // keeps its Checks result, so its Land job is in the slot at once.
  const rerunInFlight = [...byId.values()].some((r) => {
    if (!/(^|\/)land\.yml$/.test(r.path || '') || (r.run_attempt || 1) <= 1 || r.status === 'completed') return false;
    try { return landJobInSlot(jobsOf(r.id)); } catch { return true; } // unreadable reads as in flight
  });
  const withFlag = (s) => ({ ...s, rerunInFlight });
  return withFlag(scanSlot([...byId.values()], {
    jobsOf, selfRunId, now: Date.now(),
    onStale: (run) => console.log(`ignoring stale in-flight run ${run.id} ${run.head_branch} (${run.status} since ${run.run_started_at || run.created_at})`),
  }));
}

const describe = (blockers) => blockers.map((b) => `${b.id} ${b.branch} ${b.status} ${b.why}`).join(', ');

function rerun(id, seenAttempt) {
  if (dry) { console.log(`dry-run: would re-run ${id}`); return; }
  try {
    process.stdout.write(ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`]));
  } catch (err) {
    let after = null;
    try { after = gh([`repos/${repo}/actions/runs/${id}`]); } catch { /* read-back failed: surface the POST error, not this one */ }
    if (!after || decideCancelledWait({ status: after.status, attempt: after.run_attempt, attemptBefore: seenAttempt }) !== 'resume') throw err;
    console.log(`run ${id} already moved on (attempt ${after.run_attempt}, ${after.status}), likely re-run by the sweep; nothing to do`);
    return;
  }
  console.log(`re-run requested for ${id} (Land job only; Checks result kept)`);
  settle(id);
}

// BRO-4677: the run can read `completed` for a few seconds after the POST. The
// next sweep starts the moment this one exits, and would not see the re-run in
// flight (rerunInFlight), re-running the next stranded run onto the same seat.
function settle(id, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (gh([`repos/${repo}/actions/runs/${id}`]).status !== 'completed') return;
    } catch (err) {
      console.log(`run ${id}: settle check failed (${String(err.message).split('\n')[0]}); the re-run itself went through`);
      return;
    }
    execFileSync('sleep', ['5']);
  }
  console.log(`run ${id} still reads completed after ${tries * 5}s; continuing`);
  console.log(`::warning::land re-run ${id} not visible in flight after ${tries * 5}s; a following sweep may stack another re-run`);
}

function runTargeted() {
  const run = gh([`repos/${repo}/actions/runs/${runId}`]);
  const jobs = jobsOf(runId);
  let branchExists = false;
  let branchTip;
  try {
    branchTip = gh([`repos/${repo}/git/ref/heads/${run.head_branch}`]).object.sha;
    branchExists = true;
  } catch (err) {
    if (!isRefNotFound(err)) throw err; // only a 404 means landed/deleted
  }
  const d = decideLandRetry({ run, jobs, branchExists, branchTip });
  console.log(`run ${runId} ${run.head_branch} attempt ${run.run_attempt}: ${d.retry ? 'eligible' : 'skip'} (${d.reason})`);
  if (!d.retry) return;
  const slot = slotState(runId);
  if (slot.busy) {
    // Targeted retries keep the strict free-slot rule; only the sweep uses the
    // BRO-4677 running-only exception.
    console.log(`landing slot busy (${describe(slot.blockers)}): not re-running, no attempt spent; the next sweep picks it up`);
    return;
  }
  rerun(runId, run.run_attempt);
}

function runSweep() {
  const slot = slotState();
  // Cancelled runs only (status filter): the last 24h held ~150 Land runs, so
  // an unfiltered page would drop the oldest stranded ones first.
  const since = encodeURIComponent(`>=${new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString()}`);
  const cancelledRuns = [];
  for (let p = 1; p <= 3; p += 1) {
    const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?status=cancelled&created=${since}&per_page=100&page=${p}`]).workflow_runs || [];
    cancelledRuns.push(...runs);
    if (runs.length < 100) break;
  }
  const refs = landRefs();
  const d = decideSweep({ slot, cancelledRuns, refs, now: Date.now() });
  if (d.action === 'wait') { console.log(`landing slot busy (${describe(d.blockers)}): waiting, no attempt spent`); return; }
  if (d.action !== 'inspect') { console.log(`slot free, ${d.reason}`); return; }
  if (d.reason === 'no-pending-slot-busy') console.log(`landing slot held (${describe(d.blockers)}) but the pending seat is empty: re-running the oldest eligible stranded run (BRO-4677)`);
  if (d.aged) console.log(`landing slot busy (${describe(d.blockers)}) but ${d.candidates.length} run(s) stranded past the aging threshold: re-running the oldest eligible (BRO-4676)`);
  for (const run of d.candidates) {
    const latest = (gh([`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(run.head_branch)}&per_page=1`]).workflow_runs || [])[0];
    if (supersededByNewerRun(run, latest)) {
      console.log(`run ${run.id} ${run.head_branch}: skip (newer run ${latest.id} ${latest.conclusion || latest.status})`);
      continue;
    }
    // Decide on the fresh run, not the listing: a listed run may already have
    // been re-run since (status back to queued/pending, conclusion null → skip).
    const fresh = latest || run;
    const r = decideLandRetry({ run: fresh, jobs: jobsOf(run.id), branchExists: true, branchTip: refs.get(run.head_branch) });
    console.log(`run ${run.id} ${run.head_branch} attempt ${fresh.run_attempt}: ${r.retry ? 'RETRY' : 'skip'} (${r.reason})`);
    if (r.retry) { rerun(run.id, fresh.run_attempt); return; } // one per sweep: the next Land completion sweeps again
  }
}

// ---- --stranded (BRO-4802) ----
const MAX_STRANDED_REFS = 250;
// One: two full re-runs started together finish Checks together and evict each
// other from the single pending `landing` seat.
const MAX_FULL_RERUNS_PER_PASS = 1;
const STRANDED_ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) { id identifier updatedAt state { name type } comments(first: 250) { nodes { body } } }
}`;

/** land/** refs on origin → tip sha. `heads/land` is a prefix match (a trailing slash is rejected by some proxies), so filter. */
function landRefs() {
  return new Map(gh([`repos/${repo}/git/matching-refs/heads/land`])
    .filter((r) => r.ref.startsWith('refs/heads/land/'))
    .map((r) => [r.ref.replace(/^refs\/heads\//, ''), r.object.sha]));
}

/** A dispatched Land run lists under main, not its ref, so while one is in flight no ref's state is knowable. */
function dispatchInFlight() {
  const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?event=workflow_dispatch&per_page=20`]).workflow_runs || [];
  return runs.some((r) => r.status !== 'completed');
}

async function escalateStranded(items) {
  const { landRefCardNumber } = require('./lib/cloud-worker-pick.js');
  const { strandedMarker, buildEscalationComment, escalationAction, newestPerCard } = require('./lib/land-stranded-refs.js');
  for (const it of items) console.log(`::warning::land ref ${it.branch} is stranded (${it.reason}); its work is not on main`);
  items = newestPerCard(items, landRefCardNumber);
  if (dry) { for (const it of items) console.log(`dry-run: would route to its card: ${strandedMarker(it)}`); return; }
  if (!process.env.LINEAR_API_KEY) { console.log('::warning::LINEAR_API_KEY not set: stranded landings are reported in this log only'); return; }
  const linear = require('./lib/linear-client.js');
  let todoId;
  for (const it of items) {
    const n = landRefCardNumber(it.branch);
    if (n == null) { console.log(`${it.branch}: names no card; reported here only`); continue; }
    try {
      const { issue } = await linear.graphql(STRANDED_ISSUE_QUERY, { id: `BRO-${n}` }, { timeoutMs: 15000, maxAttempts: 2 });
      if (!issue) { console.log(`${it.branch}: card BRO-${n} not found; reported here only`); continue; }
      const marker = strandedMarker(it);
      // Linear pages comments newest first, so a recent marker is always within the 250.
      const action = escalationAction({ stateType: issue.state.type, stateName: issue.state.name, comments: issue.comments.nodes, marker, cardUpdatedAt: issue.updatedAt });
      if (action === 'wait') { console.log(`${it.branch}: BRO-${n} moved in the last few hours; deciding on a later pass`); continue; }
      if (action === 'skip-already-posted') { console.log(`${it.branch}: BRO-${n} already told (${it.reason})`); continue; }
      if (action === 'log-only') { console.log(`${it.branch}: BRO-${n} is ${issue.state.name}; logged only`); continue; }
      // Move first, then comment: the comment carries the dedupe marker, so a
      // failed move after a posted comment would never be retried.
      if (action === 'comment-and-reopen') {
        if (todoId === undefined) todoId = ((await linear.getTeam()).states.nodes.find((s) => s.name === 'Todo') || {}).id || null;
        if (todoId) await linear.updateIssue(issue.id, { stateId: todoId });
      }
      await linear.createComment(issue.id, buildEscalationComment(it));
      console.log(`${it.branch}: routed to BRO-${n} (${action}, ${it.reason}; was ${issue.state.name})`);
    } catch (err) {
      console.log(`::warning::${it.branch}: could not update BRO-${n} (${String(err.message).split('\n')[0]}); the next pass retries`);
    }
  }
}

async function runStranded() {
  // Kill switch: set LAND_STRANDED_KILL_SWITCH=1 (repo variable) to stop all
  // re-runs and card routing without reverting code. The fast sweep is unaffected.
  if (/^(1|true)$/i.test(process.env.LAND_STRANDED_KILL_SWITCH || '')) { console.log('LAND_STRANDED_KILL_SWITCH set: stranded pass disabled'); return; }
  const { decideStrandedRef, isAbandonedRun } = require('./lib/land-stranded-refs.js');
  if (dispatchInFlight()) { console.log('a dispatched Land run is in flight (it lists under main, not its ref): skipping this pass'); return; }
  const now = Date.now();
  // Newest successful landing per card, from any ref. Land deletes a landed
  // ref, but an older attempt for the same card (the refused original of a
  // rebased retry) stays behind and must not read as lost work.
  const { landRefCardNumber } = require('./lib/cloud-worker-pick.js');
  const cardLandedAt = new Map();
  for (let p = 1; p <= 3; p += 1) {
    const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?status=success&per_page=100&page=${p}`]).workflow_runs || [];
    for (const r of runs) {
      const n = landRefCardNumber(r.head_branch);
      if (n != null && (!cardLandedAt.has(n) || r.updated_at > cardLandedAt.get(n))) cardLandedAt.set(n, r.updated_at);
    }
    if (runs.length < 100) break;
  }
  const decisions = [];
  for (const [branch, tip] of [...landRefs()].filter(([b]) => !only || b === only).slice(0, MAX_STRANDED_REFS)) {
    // One unreadable ref (a 502 on its run or jobs) skips that ref this pass, never the whole pass.
    try {
      const latestRun = (gh([`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(branch)}&per_page=1`]).workflow_runs || [])[0] || null;
      const forTip = latestRun && latestRun.head_sha === tip;
      const jobs = forTip && latestRun.status === 'completed' && latestRun.conclusion !== 'success' && !isAbandonedRun(latestRun, now)
        ? jobsOf(latestRun.id) : null;
      let tipCommittedAt = null;
      if (!forTip) {
        try { tipCommittedAt = gh([`repos/${repo}/commits/${tip}`]).commit.committer.date; } catch (err) { console.log(`${branch}: tip date unreadable (${String(err.message).split('\n')[0]})`); }
      }
      const d = decideStrandedRef({ tip, latestRun, jobs, tipCommittedAt, cardLandedAt: cardLandedAt.get(landRefCardNumber(branch)), now });
      if (d.reason !== 'abandoned' && d.reason !== 'superseded') console.log(`${branch} @${tip.slice(0, 10)}: ${d.action} (${d.reason})${latestRun ? ` run ${latestRun.id} attempt ${latestRun.run_attempt}` : ''}`);
      decisions.push({ branch, tip, latestRun, ...d });
    } catch (err) {
      console.log(`::warning::${branch}: skipped this pass (${String(err.message).split('\n')[0]})`);
    }
  }
  const escalate = decisions.filter((d) => d.action === 'escalate');
  const reruns = decisions.filter((d) => d.action === 'rerun')
    .sort((a, b) => Date.parse(a.latestRun.updated_at) - Date.parse(b.latestRun.updated_at))
    .slice(0, MAX_FULL_RERUNS_PER_PASS);
  for (const d of reruns) {
    if (dry) { console.log(`dry-run: would re-run ${d.latestRun.id} in full (${d.branch})`); continue; }
    try {
      ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${d.latestRun.id}/rerun`]);
      console.log(`full re-run requested for ${d.latestRun.id} (${d.branch}): Checks re-verify the tip on today's main`);
    } catch (err) {
      // e.g. a run past GitHub's 30-day re-run limit: a worker has to re-push it.
      console.log(`::warning::re-run of ${d.latestRun.id} refused (${String(err.message).split('\n')[0]})`);
      escalate.push({ ...d, action: 'escalate', reason: 'rerun-refused' });
    }
  }
  if (escalate.length) await escalateStranded(escalate);
  const superseded = decisions.filter((d) => d.reason === 'superseded').map((d) => d.branch);
  if (superseded.length) console.log(`${superseded.length} leftover ref(s) whose card landed from another ref (safe to delete): ${superseded.join(' ')}`);
  const abandoned = decisions.filter((d) => d.reason === 'abandoned').map((d) => d.branch);
  if (abandoned.length) console.log(`::notice::${abandoned.length} land ref(s) idle over the abandon window (not routed): ${abandoned.join(' ')}`);
  console.log(`stranded pass: ${decisions.length} land ref(s), ${reruns.length} full re-run(s), ${escalate.length} routed to cards, ${abandoned.length} abandoned`);
}

if (sweep) runSweep();
else if (stranded) runStranded().catch((err) => { console.error(err); process.exit(1); });
else runTargeted();
