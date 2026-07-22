/**
 * dispatch-rescore.js
 *
 * Shared workflow_dispatch helper for llm-ensemble-score.yml (per-show rescore
 * + fast rebuild). Extracted from verify-all-scored.js so the T1 silent-gap
 * sweep can self-heal 'unscored' gaps by dispatching scoring instead of
 * emailing the operator the dispatch command (2026-07-21: Midnight at the
 * Never Get CRITICAL email listed `gh workflow run ...` as the fix for 4 gaps
 * the workflow could have dispatched itself).
 *
 * Requires GITHUB_TOKEN or REVIEW_TEXTS_TOKEN with actions:write on the
 * public repo. Callers pass a `reason` prefix so the workflow's per-show
 * concurrency lane records who dispatched.
 */

'use strict';

const REPO_OWNER = process.env.GITHUB_REPOSITORY?.split('/')?.[0] || 'thomaspryor';
const REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')?.[1] || 'Broadwayscore';

/**
 * @param {string} showId
 * @param {{ reason?: string }} [opts] reason prefix for the concurrency lane
 *   (default 'auto-rescore'); final rescore_reason is `${reason}-${showId}`.
 * @returns {Promise<{ok: boolean, error?: string}>} never throws
 */
async function dispatchRescore(showId, { reason = 'auto-rescore' } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return { ok: false, error: 'no-token' };
  }
  const body = {
    ref: 'main',
    inputs: {
      show_id: showId,
      fast_rebuild: 'true',
      run_calibration: 'false',
      run_validation: 'false',
      // Per-show concurrency lane (matches /ingest pattern). Without a
      // per-show suffix every dispatch queues into the same default group.
      rescore_reason: `${reason}-${showId}`,
    },
  };
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/llm-ensemble-score.yml/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-dispatch-rescore',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `${res.status} ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { dispatchRescore };
