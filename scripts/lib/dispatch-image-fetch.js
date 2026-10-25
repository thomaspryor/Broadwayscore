/**
 * dispatch-image-fetch.js
 *
 * Shared workflow_dispatch helper for fetch-all-image-formats.yml. Same
 * pattern as dispatch-rescore.js (card #1456): closes the gap where a new
 * show goes live fully scored with images:{} and nothing fetches a poster
 * until the next twice-weekly image cron (up to 3.5 days).
 *
 * Token lookup includes GH_TOKEN (not just GITHUB_TOKEN/REVIEW_TEXTS_TOKEN)
 * because the regional auto-promotion step in scrape-new-aggregators.yml
 * only sets GH_TOKEN: ${{ github.token }} for its sibling `gh workflow run`
 * calls — second-opinion review caught this (2026-08-14), see card #1456.
 *
 * Never throws — callers get {ok, error} back.
 */

'use strict';

const { dispatchWorkflow } = require('./gh-api-client.js');

const REPO_OWNER = process.env.GITHUB_REPOSITORY?.split('/')?.[0] || 'thomaspryor';
const REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')?.[1] || 'Broadwayscore';

/**
 * @param {string} showId A single id, OR a comma-separated batch of ids
 *   (BRO-2672: image-trigger-guard.js's buildImageDispatchInputs() batches
 *   every promoted show into one comma-joined show_id so a multi-show
 *   promotion fires ONE workflow_dispatch, not one per show — the job's
 *   single-slot concurrency group silently cancels every dispatch after the
 *   first, so N separate calls meant most never ran). This function itself
 *   is unchanged — it just forwards whatever string it's given.
 * @returns {Promise<{ok: boolean, error?: string}>} never throws
 */
async function dispatchImageFetch(showId) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return { ok: false, error: 'no-token' };
  }
  if (!showId || typeof showId !== 'string') {
    return { ok: false, error: 'no-show-id' };
  }
  const inputs = {
    show_id: showId,
    only_missing: 'true',
  };
  return dispatchWorkflow({ workflow: 'fetch-all-image-formats.yml', inputs, token, caller: 'dispatch-image-fetch', repo: `${REPO_OWNER}/${REPO_NAME}` });
}

module.exports = { dispatchImageFetch };
