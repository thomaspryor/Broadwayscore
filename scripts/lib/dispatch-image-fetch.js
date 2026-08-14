/**
 * dispatch-image-fetch.js
 *
 * Shared workflow_dispatch helper for fetch-all-image-formats.yml, scoped to
 * a single show_id. Same pattern as dispatch-rescore.js (card #1456): closes
 * the gap where a new show goes live fully scored with images:{} and nothing
 * fetches a poster until the next twice-weekly image cron (up to 3.5 days).
 *
 * Token lookup includes GH_TOKEN (not just GITHUB_TOKEN/REVIEW_TEXTS_TOKEN)
 * because the regional auto-promotion step in scrape-new-aggregators.yml
 * only sets GH_TOKEN: ${{ github.token }} for its sibling `gh workflow run`
 * calls — second-opinion review caught this (2026-08-14), see card #1456.
 *
 * Never throws — callers get {ok, error} back.
 */

'use strict';

const REPO_OWNER = process.env.GITHUB_REPOSITORY?.split('/')?.[0] || 'thomaspryor';
const REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')?.[1] || 'Broadwayscore';

/**
 * @param {string} showId
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
  const body = {
    ref: 'main',
    inputs: {
      show_id: showId,
      only_missing: 'true',
    },
  };
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/fetch-all-image-formats.yml/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-dispatch-image-fetch',
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

module.exports = { dispatchImageFetch };
