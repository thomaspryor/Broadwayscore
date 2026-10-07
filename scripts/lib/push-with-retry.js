'use strict';
/**
 * Node wrapper around scripts/lib/push-with-retry.sh. Task #420.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six JS/TS call sites had each hand-rolled the same commit→fetch→rebase→
 * merge-fallback→push retry loop that push-with-retry.sh already implements
 * (collect-review-texts.js ×2, rediscover-review-urls.js ×2, llm-scoring/
 * index.ts, verify-existing-reviews.js ×2, backfill-playwright-credits.js,
 * deep-research-commercial.js). Every hand-rolled copy therefore MISSED each
 * fix the shared helper received:
 *   #394 — the explicit-destination fetch refspec (a bare `git fetch origin
 *          main` leaves refs/remotes/origin/main stale under a SHA-pinned
 *          checkout, so the rebase is a silent no-op and every push is
 *          rejected "fetch first" until the retries are exhausted)
 *   #464 — no doubled 90s fetch timeout
 *   #466 — the depth bound: an unbounded fetch from a fetch-depth: 1 checkout
 *          makes the server send the WHOLE 165k-commit / ~2.1 GB repo
 *   #543 — HEAD preservation, so an abort can never strand local commits
 *   plus the conflict-marker, orphan-commit and post-rebase survival guards.
 *
 * Routing every JS caller through here means the seventh fix lands everywhere
 * at once. scripts/audit-unbounded-fetch.js is the lint gate that keeps a new
 * hand-rolled copy from appearing.
 *
 * FAILURE SEMANTICS
 * -----------------
 * Returns {ok, code, stderr} instead of throwing. Every call site is a
 * mid-run CHECKPOINT push whose failure is deliberately non-fatal (the work is
 * still on disk and a later checkpoint or the workflow's final commit step
 * publishes it), so a throw here would convert a recoverable hiccup into a
 * dead job. Callers that DO want a hard failure check `ok`.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'push-with-retry.sh');

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]       repo to push from — pass the review-texts
 *                                  clone for private-repo checkpoints. Default:
 *                                  the caller's process cwd.
 * @param {string} [opts.branch]    push refspec, e.g. 'main' or 'HEAD:main'.
 * @param {number} [opts.retries]   max attempts (the shell default is 7).
 * @param {number} [opts.deadlineSec] overall wall-clock budget; sets
 *                                  PUSH_DEADLINE_SEC for this call only. Leave
 *                                  unset to inherit the shared 240s default —
 *                                  raise it only after confirming the calling
 *                                  job's own timeout has headroom (see the
 *                                  PUSH_DEADLINE_SEC note in the .sh).
 * @param {boolean} [opts.reconcileMergedJson] set PUSH_RECONCILE_MERGED_JSON=1
 *                                  for this call. Turn it ON when the commit
 *                                  touches a union-merged file (commercial*.json,
 *                                  diary-shows.json, social-post-history.json):
 *                                  `rebase -X theirs` resolves those in favour of
 *                                  the local side WITHOUT conflicting, so the
 *                                  per-slug merger never runs and a concurrent
 *                                  writer's entry is silently lost. Default off —
 *                                  the ~114 existing callers keep today's exact
 *                                  behaviour.
 * @param {'pipe'|'inherit'} [opts.stdio] default 'pipe' (quiet checkpoints).
 * @returns {{ok: boolean, code: number|null, stderr: string}}
 */
function pushWithRetry(opts = {}) {
  const {
    cwd = process.cwd(),
    branch = 'HEAD:main',
    retries = 5,
    deadlineSec,
    reconcileMergedJson = false,
    stdio = 'pipe',
  } = opts;

  const env = { ...process.env };
  if (deadlineSec) env.PUSH_DEADLINE_SEC = String(deadlineSec);
  if (reconcileMergedJson) env.PUSH_RECONCILE_MERGED_JSON = '1';

  try {
    const out = execFileSync('bash', [SCRIPT_PATH, String(retries), branch], {
      cwd,
      env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, code: 0, stderr: '', stdout: out || '' };
  } catch (err) {
    // execFileSync throws on non-zero exit; surface the shell's own ::error::
    // lines so the reason (no-op rebase, shallow-ancestry abort, retries
    // exhausted) is visible in the caller's log rather than swallowed.
    const stderr = String(err.stderr || err.stdout || err.message || '').trim();
    return { ok: false, code: typeof err.status === 'number' ? err.status : null, stderr, stdout: '' };
  }
}

module.exports = { pushWithRetry, PUSH_WITH_RETRY_SH: SCRIPT_PATH };
