#!/usr/bin/env node
'use strict';

/**
 * land-retry-cancelled.js — re-run Land jobs cancelled before they did any
 * work (BRO-4246). Until BRO-5112 that was eviction from the shared `landing`
 * slot and this script spent attempts only while the slot was free; the Land
 * job's group is per branch now and the fast-forward waits in the landing
 * mutex (scripts/lib/land-mutex.js), so a re-run evicts nobody and needs no
 * slot check. Run by land-retry-cancelled.yml.
 *
 *   node scripts/land-retry-cancelled.js --sweep [--dry-run]
 *     Re-run stranded cancelled Land runs, oldest first (main-red lanes
 *     first): one per sweep, or for parked runs as many as the landing queue
 *     has resume room for (BRO-6015, land-mutex.js resumeSlots).
 *   node scripts/land-retry-cancelled.js --run=<id> [--dry-run]
 *     Targeted retry of one run (a parked run waits for queue room too).
 *   node scripts/land-retry-cancelled.js --stranded [--only=<land/branch>] [--dry-run]
 *     Hourly pass over every land/** ref still on origin (BRO-4802): a ref
 *     evicted outside the fast-retry window gets a FULL re-run (Checks again
 *     on today's main), spaced an hour apart; a refused, red or budget-spent
 *     ref is routed to the card it names (comment with resume steps, card
 *     back to Todo). Decisions: scripts/lib/land-stranded-refs.js.
 *
 * Decisions: scripts/lib/land-retry-on-cancel.js (is this run a queue
 * casualty?) and scripts/lib/land-queue-backoff.js (which run goes next?).
 */

const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { decideLandRetry, isRerunRefused, runGhWithFallback, isRefNotFound, decideCancelledWait } = require('./lib/land-retry-on-cancel');
const { supersededByNewerRun, decideSweep, sweepStep, listedRunRefusal, MAX_AGE_HOURS } = require('./lib/land-queue-backoff');
const { resolveLandRun, readLatestLandRun } = require('./lib/land-run-identity');

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
// Listing reads are memoized per process: every sweep candidate's
// readLatestLandRun walks the same workflow_dispatch pages (BRO-6276).
const listingCache = new Map();
const readListing = (endpoint) => {
  if (!listingCache.has(endpoint)) listingCache.set(endpoint, gh([endpoint]));
  return listingCache.get(endpoint);
};
const identityOptions = { repo, read: readListing, readText: (endpoint) => ghRaw([endpoint]), cache: new Map() };

// Memoized: the targeted and sweep decisions can ask about the same run.
const jobsCache = new Map();
const jobsOf = (id) => {
  if (!jobsCache.has(String(id))) jobsCache.set(String(id), gh([`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=50`]).jobs);
  return jobsCache.get(String(id));
};

/**
 * Re-run one run's failed jobs. Returns 'requested', 'moved-on' (already going
 * again) or 'refused' (BRO-6326: GitHub says the run cannot be retried; a
 * refusal must not abort the sweep or consume a slot). Other errors throw.
 */
function rerun(id, seenAttempt) {
  if (dry) { console.log(`dry-run: would re-run ${id}`); return 'requested'; }
  try {
    process.stdout.write(ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`]));
  } catch (err) {
    let after = null;
    try { after = gh([`repos/${repo}/actions/runs/${id}`]); } catch { /* read-back failed: surface the POST error, not this one */ }
    if (after && decideCancelledWait({ status: after.status, attempt: after.run_attempt, attemptBefore: seenAttempt }) === 'resume') {
      console.log(`run ${id} already moved on (attempt ${after.run_attempt}, ${after.status}), likely re-run by the sweep; nothing to do`);
      return 'moved-on';
    }
    if (!isRerunRefused(err)) throw err;
    console.log(`::warning::run ${id} cannot be retried (${String(err.message).split('\n')[0]}); skipped, not counted`);
    return 'refused';
  }
  console.log(`re-run requested for ${id} (Land job only; Checks result kept)`);
  return 'requested';
}

function runTargeted() {
  const raw = gh([`repos/${repo}/actions/runs/${runId}`]);
  const run = resolveLandRun(raw, identityOptions);
  if (!run) { console.log(`run ${runId}: skip (dispatched branch and checked tip not readable yet)`); return; }
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
  // BRO-6015: resuming a parked run into a full queue re-parks it and spends
  // an attempt, the same check the sweep makes.
  if (d.parked && resumeSlotsNow() === 0) { console.log(`run ${runId}: parked, landing queue has no resume room yet; the sweep resumes it in order (nothing to do)`); return; }
  if (rerun(runId, run.run_attempt) === 'refused') process.exitCode = 1;
}

/**
 * Tickets under refs/land-mutex/queue on origin (BRO-5196), or null when the
 * remote is unreadable (callers resume: a parked run is never held on a guess).
 */
function queueTickets() {
  const r = spawnSync('git', ['ls-remote', process.env.LAND_MUTEX_REMOTE || 'origin', 'refs/land-mutex/*'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return null;
  return require('./lib/land-mutex').parseLsRemote(r.stdout).tickets;
}

/** Land runs re-run and still queued or running (they may not hold a ticket yet). */
function inflightResumedRunIds() {
  const ids = [];
  for (const status of ['queued', 'in_progress']) {
    const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?status=${status}&per_page=100`]).workflow_runs || [];
    ids.push(...runs.filter((r) => (r.run_attempt || 1) > 1).map((r) => r.id));
  }
  return ids;
}

/** Parked runs that may be resumed right now (one ls-remote + two run listings). */
function resumeSlotsNow() {
  const lm = require('./lib/land-mutex');
  const tickets = queueTickets();
  let inflight = [];
  // Unreadable listing: count nothing in flight; the headroom cap still bounds the sweep.
  if (tickets) { try { inflight = inflightResumedRunIds(); } catch (err) { console.log(`could not list in-flight Land runs (${err.message.split('\n')[0]}); counting none`); } }
  const slots = lm.resumeSlots({ tickets, inflightResumedRunIds: inflight, cap: lm.parkDepth(), headroom: lm.resumeHeadroom() });
  console.log(`landing queue: ${tickets ? lm.liveTicketCount(tickets) : 'unreadable'} live ticket(s), ${inflight.length} resumed run(s) in flight, resume room ${slots}`);
  return slots;
}

function runSweep() {
  // Cancelled runs only (status filter): the last 24h held ~150 Land runs, so
  // an unfiltered page would drop the oldest stranded ones first.
  const since = encodeURIComponent(`>=${new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString()}`);
  const cancelledRuns = [];
  for (let p = 1; p <= 3; p += 1) {
    const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?status=cancelled&created=${since}&per_page=100&page=${p}`]).workflow_runs || [];
    cancelledRuns.push(...runs.map((run) => resolveLandRun(run, identityOptions)).filter(Boolean));
    if (runs.length < 100) break;
  }
  const refs = landRefs();
  const d = decideSweep({ cancelledRuns, refs, now: Date.now() });
  if (d.action !== 'inspect') { console.log(d.reason); return; }
  // Resume room is read once, on the first parked candidate (one ls-remote +
  // two listings); until then it is unknown, so a parked step reads it.
  let slots;
  let resumed = 0;
  let evictionRerun = false;
  for (const run of d.candidates) {
    // BRO-6276: only survivors of the one-call jobs check pay for the lookup below.
    const refusal = listedRunRefusal(run, { jobsOf, refs });
    if (refusal) { console.log(`run ${run.id} ${run.head_branch}: skip (${refusal})`); continue; }
    const latest = readLatestLandRun(run.head_branch, identityOptions);
    if (supersededByNewerRun(run, latest)) {
      console.log(`run ${run.id} ${run.head_branch}: skip (newer run ${latest.id} ${latest.conclusion || latest.status})`);
      continue;
    }
    // Decide again on the fresh run and the jobs read: a listed run may have
    // been re-run since (status back to queued/pending, conclusion null → skip).
    const fresh = latest || resolveLandRun(gh([`repos/${repo}/actions/runs/${run.id}`]), identityOptions);
    if (!fresh) continue;
    const r = decideLandRetry({ run: fresh, jobs: jobsOf(run.id), branchExists: true, branchTip: refs.get(run.head_branch) });
    console.log(`run ${run.id} ${run.head_branch} attempt ${fresh.run_attempt}: ${r.retry ? 'RETRY' : 'skip'} (${r.reason})`);
    if (!r.retry) continue;
    // A parked run resumes only when the queue has room; resuming into a full
    // queue just parks it again and spends an attempt (BRO-5196). Parked runs
    // fill every free resume slot, oldest first (BRO-6015: one per sweep lost
    // each freed slot to a fresh push); one eviction re-run per sweep.
    if (r.parked && slots === undefined) slots = resumeSlotsNow();
    const step = sweepStep({ parked: Boolean(r.parked), slots, resumed, evictionRerun });
    if (step === 'stop') break;
    if (step === 'skip') { if (r.parked) console.log(`run ${run.id} ${run.head_branch}: parked, no resume room left this sweep; not resumed yet`); continue; }
    let outcome;
    try { outcome = rerun(run.id, fresh.run_attempt); } catch (err) {
      console.log(`::error::run ${run.id} ${run.head_branch}: re-run failed (${String(err.message).split('\n')[0]}); continuing the sweep`);
      process.exitCode = 1;
      continue;
    }
    if (outcome === 'refused') continue;
    if (step === 'resume') resumed += 1; else evictionRerun = true;
  }
  if (resumed) console.log(`resumed ${resumed} parked run(s) this sweep`);
}

// A hand cancel is news for the card even while its holder is active, so it
// skips escalationAction's idle wait and never moves the card (BRO-6276).
async function reportHandCancels(items) {
  const { landRefCardNumber } = require('./lib/cloud-worker-pick.js');
  const { strandedMarker, buildHandCancelComment } = require('./lib/land-stranded-refs.js');
  for (const it of items) console.log(`::warning::land run ${it.latestRun.id} (${it.branch}) was cancelled by @${it.cancelledBy}, not by the landing queue`);
  if (dry) { for (const it of items) console.log(`dry-run: would note on its card: ${strandedMarker({ ...it, reason: 'cancelled-by-hand' })}`); return; }
  if (!process.env.LINEAR_API_KEY) return;
  const linear = require('./lib/linear-client.js');
  for (const it of items) {
    const n = landRefCardNumber(it.branch);
    if (n == null) continue;
    try {
      const { issue } = await linear.graphql(STRANDED_ISSUE_QUERY, { id: `BRO-${n}` }, { timeoutMs: 15000, maxAttempts: 2 });
      if (!issue) continue;
      const marker = strandedMarker({ ...it, reason: 'cancelled-by-hand' });
      if (issue.comments.nodes.some((c) => String((c && c.body) || '').includes(marker))) continue;
      await linear.createComment(issue.id, buildHandCancelComment(it));
      console.log(`${it.branch}: hand cancel noted on BRO-${n}`);
    } catch (err) {
      console.log(`::warning::${it.branch}: could not note the hand cancel on BRO-${n} (${String(err.message).split('\n')[0]}); the next pass retries`);
    }
  }
}

// ---- --stranded (BRO-4802) ----
const MAX_STRANDED_REFS = 250;
// One per hourly pass: a full re-run is ~10-30 min of Checks, and a backlog
// re-run all at once would crowd the runners (no eviction since BRO-5112).
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
  if (dry) { for (const it of items) console.log(`dry-run: would route to its card: ${strandedMarker(it)}${it.cancelledBy ? ` (cancelled by @${it.cancelledBy})` : ''}`); return; }
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
  const { decideStrandedRef, isAbandonedRun, cancelledJobs, cancelledByFromAnnotations, isHandCancel } = require('./lib/land-stranded-refs.js');
  const handCancels = [];
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
      // BRO-6276: name a hand cancel (a person's or session's token, not Admit's park).
      // Either job's annotation may carry the canceller; a superseded ref is not owed a comment.
      const cJobs = latestRun && latestRun.conclusion === 'cancelled' && d.reason !== 'superseded' ? cancelledJobs(jobs) : [];
      for (const cJob of cJobs) {
        try {
          d.cancelledBy = cancelledByFromAnnotations(gh([`repos/${repo}/check-runs/${cJob.id}/annotations`]));
        } catch (err) { console.log(`${branch}: cancel annotation unreadable (${String(err.message).split('\n')[0]})`); }
        if (d.cancelledBy) break;
      }
      if (isHandCancel(d.cancelledBy) && d.action !== 'escalate') handCancels.push({ branch, tip, latestRun, cancelledBy: d.cancelledBy, followUp: d.action });
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
  if (handCancels.length) await reportHandCancels(handCancels);
  const superseded = decisions.filter((d) => d.reason === 'superseded').map((d) => d.branch);
  if (superseded.length) console.log(`${superseded.length} leftover ref(s) whose card landed from another ref (safe to delete): ${superseded.join(' ')}`);
  const abandoned = decisions.filter((d) => d.reason === 'abandoned').map((d) => d.branch);
  if (abandoned.length) console.log(`::notice::${abandoned.length} land ref(s) idle over the abandon window (not routed): ${abandoned.join(' ')}`);
  console.log(`stranded pass: ${decisions.length} land ref(s), ${reruns.length} full re-run(s), ${escalate.length} routed to cards, ${abandoned.length} abandoned`);
}

if (sweep) runSweep();
else if (stranded) runStranded().catch((err) => { console.error(err); process.exit(1); });
else runTargeted();
