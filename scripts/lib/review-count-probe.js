'use strict';

const fs = require('fs');
const path = require('path');
const { isIncludableForRebuild } = require('./review-guards');

/**
 * Reads all JSON files in the show's review-texts directory, applies
 * isIncludableForRebuild to each, and returns counts.
 *
 * @param {string} showId
 * @param {string} reviewTextsRoot  default: 'data/review-texts'
 * @returns {{ total: number, included: number, excluded: number }}
 */
function countLocalIncluded(showId, reviewTextsRoot = 'data/review-texts') {
  const dir = path.join(reviewTextsRoot, showId);
  if (!fs.existsSync(dir)) {
    return { total: 0, included: 0, excluded: 0 };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let included = 0;
  let excluded = 0;
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      excluded++;
      continue;
    }
    if (isIncludableForRebuild(data)) {
      included++;
    } else {
      excluded++;
    }
  }
  return { total: files.length, included, excluded };
}

/**
 * Counts reviews for a show in a parsed reviews.json document.
 * Handles both array and {reviews: [...]} shapes.
 *
 * @param {string} showId
 * @param {Array|{reviews: Array}} reviewsDoc
 * @returns {number}
 */
function countAggregate(showId, reviewsDoc) {
  const list = Array.isArray(reviewsDoc)
    ? reviewsDoc
    : (reviewsDoc && reviewsDoc.reviews) || [];
  return list.filter(r => r.showId === showId || r.show === showId).length;
}

/**
 * Fetches the live review count from the production JSON endpoint.
 * The per-show JSON uses the `rc` field (verified 2026-04-16).
 *
 * @param {string} showId
 * @returns {Promise<{ rc: number|null, err: string|null }>}
 */
async function fetchLiveRc(showId) {
  const url = `https://broadwayscorecard.com/data/shows/${showId}.json`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'cache-control': 'no-cache' },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { rc: null, err: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const rc = typeof json.rc === 'number' ? json.rc : null;
    return { rc, err: rc == null ? 'field rc not found in response' : null };
  } catch (err) {
    clearTimeout(timer);
    return { rc: null, err: err.name === 'AbortError' ? 'timeout (8s)' : String(err) };
  }
}

/**
 * Reads the local per-show JSON (stage 3) and returns both the cached `rc`
 * count and the actual length of the `rv` reviews array. Returns null if the
 * file is missing or unreadable.
 *
 * Pairs with fetchLiveRc: fetchLiveRc reads the same file served from CDN
 * (stage 4), countLocalPerShowJson reads it from the local filesystem (stage 3).
 * Drift between the two isolates deploy-lag from generation bugs.
 *
 * @param {string} showId
 * @param {string} publicDataRoot  default: 'public/data/shows'
 * @returns {{ rc: number|null, reviewsArrayLength: number }|null}
 */
function countLocalPerShowJson(showId, publicDataRoot = 'public/data/shows') {
  const filePath = path.join(publicDataRoot, `${showId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rc = typeof data.rc === 'number' ? data.rc : null;
    const reviewsArrayLength = Array.isArray(data.rv) ? data.rv.length : 0;
    return { rc, reviewsArrayLength };
  } catch {
    return null;
  }
}

/**
 * Computes drift from the three count sources.
 * If live.rc is null, drift = |local - aggregate|.
 *
 * @param {{ local: number, aggregate: number, live: number|null }} counts
 * @returns {{ min: number, max: number, drift: number }}
 */
function computeDrift({ local, aggregate, live }) {
  const values = [local, aggregate];
  if (live != null) values.push(live);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, drift: max - min };
}

module.exports = {
  countLocalIncluded,
  countAggregate,
  fetchLiveRc,
  countLocalPerShowJson,
  computeDrift,
};
