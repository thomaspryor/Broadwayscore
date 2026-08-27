/**
 * dispatch-express-retry.js
 *
 * Shared workflow_dispatch helper for opening-night-express.yml's same-night
 * retry (card #1889). Mirrors scripts/lib/dispatch-rescore.js's shape — a
 * direct fetch() to the GitHub Actions dispatch API with a bearer token,
 * not a `gh` CLI shell-out — so the retry-check cron doesn't need the `gh`
 * binary configured and errors come back as data instead of thrown strings.
 */

'use strict';

const REPO_OWNER = process.env.GITHUB_REPOSITORY?.split('/')?.[0] || 'thomaspryor';
const REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')?.[1] || 'Broadwayscore';

/**
 * @param {string} showId
 * @param {string} market 'broadway' | 'west-end'
 * @returns {Promise<{ok: boolean, error?: string}>} never throws
 */
async function dispatchExpressRetry(showId, market) {
  const token = process.env.GITHUB_TOKEN || process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return { ok: false, error: 'no-token' };
  }
  const body = {
    ref: 'main',
    inputs: {
      show_id: showId,
      market,
      is_retry: 'true',
    },
  };
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/opening-night-express.yml/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-dispatch-express-retry',
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

module.exports = { dispatchExpressRetry };
