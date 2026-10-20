'use strict';

/**
 * BRO-5793: which staged candidates may NOT block a re-fetch of their URL.
 *
 * extract-aggregator-candidates.js skips any URL already in staging. A BWW
 * roundup is a LiveBlogPosting that gains outlets over time, so a row first
 * staged at opening night with 1-2 outlets would stay below the BRO-125 3+
 * threshold forever. Roundup rows (bww-roundup / playbill-verdict) whose
 * reviewCount is below threshold and whose article is still recent are
 * therefore re-fetched; the fresh row replaces the old one by candidateHash
 * (writeStagingCandidates). Pure/IO-free (CLAUDE.md §15).
 */

const { REGIONAL_REVIEW_THRESHOLD, meetsReviewThreshold } = require('./review-threshold');

const REFETCH_SOURCES = new Set(['bww-roundup', 'playbill-verdict']);
const REFETCH_WINDOW_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True when a staged row should be re-fetched rather than skipped. */
function shouldRefetchStaged(row, options = {}) {
  if (!row || !REFETCH_SOURCES.has(row.source)) return false;
  const threshold = options.threshold ?? REGIONAL_REVIEW_THRESHOLD;
  if (meetsReviewThreshold(row.reviewCount, threshold)) return false;
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? REFETCH_WINDOW_DAYS;
  const published = Date.parse(row.articlePublishedAt);
  // Unknown/unparseable date: fall back to discoveredAt; still unknown → stop re-fetching.
  const anchor = Number.isFinite(published) ? published : Date.parse(row.discoveredAt);
  if (!Number.isFinite(anchor)) return false;
  return now - anchor <= windowDays * DAY_MS;
}

/** URLs of staged rows that should block a re-fetch (the idempotency set). */
function buildStagedUrlSkipSet(stagedRows, options = {}) {
  const urls = new Set();
  for (const row of stagedRows || []) {
    if (!row || !row.sourceUrl) continue;
    if (shouldRefetchStaged(row, options)) continue;
    urls.add(row.sourceUrl);
  }
  return urls;
}

module.exports = { REFETCH_SOURCES, REFETCH_WINDOW_DAYS, shouldRefetchStaged, buildStagedUrlSkipSet };
