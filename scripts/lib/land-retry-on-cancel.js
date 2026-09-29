'use strict';

/**
 * land-retry-on-cancel.js — pure decision for BRO-4246.
 *
 * land.yml's `land` job sits in the global concurrency group `landing`
 * (cancel-in-progress: false). GitHub keeps ONE pending run per group, so a
 * queued Land job is cancelled when a newer landing queues behind it, even
 * though its Checks job passed. This decides whether a completed Land run is
 * that case and should be re-run (`gh run rerun <id> --failed`, which re-runs
 * only the cancelled Land job and keeps the verified Checks result).
 *
 * Retry ONLY when: the run is cancelled, Checks succeeded, Land was cancelled
 * before doing any work (no step ran to completion past queueing — a Land job
 * cancelled mid-flight by a human must not be replayed), the land/** ref still
 * exists (it is deleted once landed) at the same tip the run verified, and the attempt budget is not spent.
 */

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
  const started = (land.steps || []).some((s) => s.conclusion === 'success' || s.conclusion === 'failure');
  if (started) return no('land-started-work');
  if (!branchExists) return no('branch-gone');
  if (branchTip && run.head_sha && branchTip !== run.head_sha) return no('superseded-tip');
  const attempt = run.run_attempt || 1;
  if (attempt >= maxAttempts) return no('attempts-exhausted');
  return { retry: true, reason: 'land-cancelled-while-queued', attempt };
}

module.exports = { decideLandRetry, MAX_ATTEMPTS };
