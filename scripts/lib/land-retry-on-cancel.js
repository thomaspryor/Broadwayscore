'use strict';

/**
 * land-retry-on-cancel.js — pure decision for BRO-4246.
 *
 * land.yml's `land` job sat in the global concurrency group `landing` until
 * BRO-5112 (now per branch, with the git-ref landing mutex serializing the
 * fast-forward). GitHub keeps ONE pending run per group, so a queued Land job
 * could be cancelled before doing any work even though its Checks job passed
 * (still possible for a same-branch run or a pre-BRO-5112 definition). This
 * decides whether a completed Land run is that case and should be re-run (`gh run rerun <id> --failed`, which re-runs
 * only the cancelled Land job and keeps the verified Checks result).
 *
 * Retry ONLY when: the run is cancelled, Checks succeeded, Land was cancelled
 * before "Land the branch" ran (landWorkStarted; a job cancelled while landing
 * must not be replayed). BRO-6291: a cancel during setup or the landing-mutex
 * wait is retried too, nothing reached main; delete the land/** ref to stop a
 * landing for good. Also required: the land/** ref still
 * exists (it is deleted once landed) at the same tip the run verified, and the attempt budget is not spent.
 */

const { PARKED_MAX_ATTEMPTS, isParkedLandJob, landWorkStarted } = require('./land-mutex');

const MAX_ATTEMPTS = 6;
// land.yml's Land job timeout-minutes (pinned by land-mutex.test.mjs). GitHub
// reports a job deadline as "cancelled"; a Land job that ran this close to it
// most likely timed out (hung mutex, checkout or install), and replaying it
// would burn up to MAX_ATTEMPTS more two-hour runs. Leave it to a person.
const LAND_JOB_TIMEOUT_MINUTES = 125;
const TIMEOUT_SUSPECT_MINUTES = LAND_JOB_TIMEOUT_MINUTES - 5;

function landRanToDeadline(land) {
  const ms = Date.parse(land.completed_at) - Date.parse(land.started_at);
  return Number.isFinite(ms) && ms >= TIMEOUT_SUSPECT_MINUTES * 60000;
}

// BRO-6326: `jobs?filter=latest` can list every attempt's job of the same name
// (run 40307546415: attempt-1 Land cancelled + attempt-2 Land success). find()
// took the stale first one, so a landed run looked retryable. Newest attempt
// wins; started_at breaks ties (a job cancelled while queued may lack it).
function latestJobByName(jobs, name) {
  const key = (j) => [Number(j.run_attempt) || 0, Date.parse(j.started_at) || 0];
  return (jobs || []).filter((j) => j.name === name).reduce((best, j) => {
    if (!best) return j;
    const [a, at] = key(j); const [b, bt] = key(best);
    return a > b || (a === b && at > bt) ? j : best;
  }, null) || undefined;
}

function decideLandRetry({ run, jobs, branchExists, branchTip, maxAttempts = MAX_ATTEMPTS } = {}) {
  const no = (reason) => ({ retry: false, reason });
  if (!run) return no('no-run');
  if (run.conclusion !== 'cancelled') return no(`run-conclusion-${run.conclusion || 'none'}`);
  if (!/^land\//.test(run.head_branch || '')) return no('not-a-land-branch');
  const checks = latestJobByName(jobs, 'Checks');
  const land = latestJobByName(jobs, 'Land');
  if (!checks || checks.conclusion !== 'success') return no('checks-not-success');
  if (!land) return no('no-land-job');
  if (land.conclusion !== 'cancelled') return no(`land-${land.conclusion || 'none'}`);
  // BRO-5196: a Land job that parked itself behind a deep landing queue (its
  // admit step cancelled the run before any work) is resumed like an eviction,
  // on its own, larger budget: it burns an attempt only when the queue is full again.
  const parked = isParkedLandJob(land);
  if (!parked && landWorkStarted(land)) return no('land-started-work');
  if (!parked && landRanToDeadline(land)) return no('land-timed-out');
  const setupRan = !parked && (land.steps || []).some((s) => s.conclusion === 'success' || s.conclusion === 'failure');
  if (!branchExists) return no('branch-gone');
  if (branchTip && run.head_sha && branchTip !== run.head_sha) return no('superseded-tip');
  const attempt = run.run_attempt || 1;
  if (attempt >= (parked ? Math.max(maxAttempts, PARKED_MAX_ATTEMPTS) : maxAttempts)) return no('attempts-exhausted');
  return parked
    ? { retry: true, reason: 'land-parked-behind-deep-queue', attempt, parked: true }
    : { retry: true, reason: setupRan ? 'land-cancelled-before-landing' : 'land-cancelled-while-queued', attempt };
}

// BRO-4651: GITHUB_TOKEN's per-repo quota is shared by every workflow and ran
// out during a landing burst (2026-10-05 00:00-01:00 UTC: all 13 retries
// failed on the first GET, stranding every evicted landing). On a rate-limit
// error, retry once with the fallback token (REVIEW_TEXTS_TOKEN, a classic PAT
// with its own quota; land.yml already pushes with it). Output is piped, never
// inherited, so the rate-limit text is readable from the thrown error.
function errorText(err) {
  return [err && err.stderr, err && err.stdout, err && err.message].map((x) => String(x || '')).join('\n');
}

// Newer gh refuses a response containing terminal escape sequences unless
// told otherwise ("pass --allow-escape-sequences"), and GitHub job logs always
// carry ANSI colour codes. Every Land identity lookup threw on the runner's gh,
// failing "Land retry on cancel" 25x/24h (BRO-6058). Older gh does not know the
// flag (unknown flag error), so it is added only when gh asks for it.
const ESCAPE_REFUSAL = /--allow-escape-sequences/;
function ghApiArgs(args, err) {
  return err && ESCAPE_REFUSAL.test(errorText(err)) && !args.includes('--allow-escape-sequences')
    ? ['--allow-escape-sequences', ...args] : args;
}

function runGhWithFallback(args, { exec, env = process.env, fallbackToken, log = console.error } = {}) {
  const { isRateLimitError } = require('./github-rate-limit-retry.js');
  // maxBuffer: a 100-run listing is >1 MB, past execFileSync's 1 MB default
  // (BRO-4653's sweep hit ENOBUFS on its first live run).
  const opts = (e) => ({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: e, maxBuffer: 64 * 1024 * 1024 });
  const call = (e, args) => {
    try { return exec('gh', ['api', ...args], opts(e)); }
    catch (err) {
      const retry = ghApiArgs(args, err);
      if (retry === args) throw err;
      return exec('gh', ['api', ...retry], opts(e));
    }
  };
  try {
    return call(env, args);
  } catch (err) {
    if (!fallbackToken || !isRateLimitError(errorText(err))) throw err;
    log(`gh api ${args.join(' ')}: GITHUB_TOKEN rate-limited, retrying with the fallback token`);
    return call({ ...env, GH_TOKEN: fallbackToken }, args);
  }
}

// Only a 404 means the land/** ref is gone (landed or deleted). A rate limit,
// 5xx or network error must not be read as "landed": that skip exits 0 and
// strands the landing silently.
function isRefNotFound(err) {
  return /\bHTTP 404\b/.test(errorText(err));
}

// BRO-6326: GitHub refuses rerun-failed-jobs with "HTTP 403 This workflow run
// cannot be retried" for a run in an unretriable state. Matched on both the
// status and the text so a permissions 403 still fails loudly.
function isRerunRefused(err) {
  const t = errorText(err);
  return /\bHTTP 403\b/.test(t) && /cannot be retried/i.test(t);
}

/**
 * Pure: after a retry-eligible cancel, has the run been re-triggered?
 * 'resume' once the run is live again or its attempt number moved past the
 * one that was cancelled; 'wait' otherwise. Unknown status reads as 'wait'.
 * Used by land-branch.js (waiting for the server re-run) and by
 * land-retry-cancelled.js: the targeted retry and the sweep can both POST
 * rerun-failed-jobs seconds apart, and the loser's POST fails while the run is
 * already going again (2026-10-05: a --run= call crashed with exit 1 right
 * after the sweep started attempt 2). 'resume' there means nothing to do.
 */
function decideCancelledWait({ status, attempt, attemptBefore } = {}) {
  const a = Number(attempt);
  const before = Number(attemptBefore);
  if (Number.isFinite(a) && Number.isFinite(before) && a > before) return 'resume';
  if (status && status !== 'completed') return 'resume';
  return 'wait';
}

module.exports = { latestJobByName, isRerunRefused, ghApiArgs, decideLandRetry, MAX_ATTEMPTS, LAND_JOB_TIMEOUT_MINUTES, runGhWithFallback, isRefNotFound, decideCancelledWait };
