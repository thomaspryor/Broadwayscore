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
 * before doing any work (no step ran to completion past queueing — a Land job
 * cancelled mid-flight by a human must not be replayed), the land/** ref still
 * exists (it is deleted once landed) at the same tip the run verified, and the attempt budget is not spent.
 */

const { PARKED_MAX_ATTEMPTS, isParkedLandJob } = require('./land-mutex');

const MAX_ATTEMPTS = 6;

function decideLandRetry({ run, jobs, branchExists, branchTip, maxAttempts = MAX_ATTEMPTS } = {}) {
  const no = (reason) => ({ retry: false, reason });
  if (!run) return no('no-run');
  if (run.conclusion !== 'cancelled') return no(`run-conclusion-${run.conclusion || 'none'}`);
  if (!/^land\//.test(run.head_branch || '')) return no('not-a-land-branch');
  const byName = (n) => (jobs || []).find((j) => j.name === n);
  const checks = byName('Checks');
  const land = byName('Land');
  if (!checks || checks.conclusion !== 'success') return no('checks-not-success');
  if (!land) return no('no-land-job');
  if (land.conclusion !== 'cancelled') return no(`land-${land.conclusion || 'none'}`);
  // BRO-5196: a Land job that parked itself behind a deep landing queue (its
  // admit step cancelled the run before any work) is resumed like an eviction,
  // on its own, larger budget: it burns an attempt only when the queue is full again.
  const parked = isParkedLandJob(land);
  const started = !parked && (land.steps || []).some((s) => s.conclusion === 'success' || s.conclusion === 'failure');
  if (started) return no('land-started-work');
  if (!branchExists) return no('branch-gone');
  if (branchTip && run.head_sha && branchTip !== run.head_sha) return no('superseded-tip');
  const attempt = run.run_attempt || 1;
  if (attempt >= (parked ? Math.max(maxAttempts, PARKED_MAX_ATTEMPTS) : maxAttempts)) return no('attempts-exhausted');
  return parked
    ? { retry: true, reason: 'land-parked-behind-deep-queue', attempt, parked: true }
    : { retry: true, reason: 'land-cancelled-while-queued', attempt };
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

function runGhWithFallback(args, { exec, env = process.env, fallbackToken, log = console.error } = {}) {
  const { isRateLimitError } = require('./github-rate-limit-retry.js');
  // maxBuffer: a 100-run listing is >1 MB, past execFileSync's 1 MB default
  // (BRO-4653's sweep hit ENOBUFS on its first live run).
  const opts = (e) => ({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: e, maxBuffer: 64 * 1024 * 1024 });
  try {
    return exec('gh', ['api', ...args], opts(env));
  } catch (err) {
    if (!fallbackToken || !isRateLimitError(errorText(err))) throw err;
    log(`gh api ${args.join(' ')}: GITHUB_TOKEN rate-limited, retrying with the fallback token`);
    return exec('gh', ['api', ...args], opts({ ...env, GH_TOKEN: fallbackToken }));
  }
}

// Only a 404 means the land/** ref is gone (landed or deleted). A rate limit,
// 5xx or network error must not be read as "landed": that skip exits 0 and
// strands the landing silently.
function isRefNotFound(err) {
  return /\bHTTP 404\b/.test(errorText(err));
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

module.exports = { decideLandRetry, MAX_ATTEMPTS, runGhWithFallback, isRefNotFound, decideCancelledWait };
