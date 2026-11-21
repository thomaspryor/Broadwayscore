'use strict';
/**
 * BRO-3497: pick the Talkin' Broadway review files that the BRO-912 extractor
 * fix (byline-anchored extractTalkinBroadwayBody, live 2026-09-16) can still
 * improve, and turn them into targeted collect-review-texts.yml batches.
 *
 * Why a dedicated selector: a plain domain_filter/content_tier run reaches
 * almost none of these files. The collector's BRO-787 lifecycle gate skips
 * reviews with a failed-fetches.json history before the domain filter applies
 * (trial run 40416013516 found 1 TB candidate out of 300+ stale files). An
 * explicit REVIEW_FILTER key ("showId/file") bypasses that gate, and the
 * "force:" prefix bypasses the has-good-text short-circuits, since the stored
 * text came from the old extractor and is known to be wrong.
 *
 * Pure functions only (no fs, no network) so the test can require them.
 */

const STALE_TIERS = new Set(['truncated', 'invalid', 'excerpt', 'stub']);

// BRO-912 closed 2026-09-16T00:12Z. Text fetched at/after this used the fixed
// extractor already; refetching it would spend credits for the same result.
const DEFAULT_FIX_DATE = '2026-09-16T00:12:15Z';

// Flags that exclude a review from the site regardless of its text, plus
// tombstones. Re-extracting them cannot change a published score.
const EXCLUSION_FLAGS = [
  'wrongProduction', 'wrongShow', 'isRoundupArticle', 'duplicateOf',
  'isNotReview', 'isNonReview', 'fabricatedEntry',
];

function isTbFileName(file) {
  return /^talkinbroadway--.+\.json$/.test(String(file || ''));
}

/** Stale = low content tier and not hand-fixed (card's original definition). */
function isStaleTbReview(data) {
  if (!data || typeof data !== 'object') return false;
  return STALE_TIERS.has(data.contentTier) && data.source !== 'manual';
}

/**
 * 'review-page' | 'forum' | 'index' | 'other-path' | 'non-tb' | 'missing'.
 * Only 'review-page' (a .html page on talkinbroadway.com: /page/world,
 * /page/ob, /page/regional and the older /world, /ob, /regional layouts) is
 * a page the byline extractor can read.
 */
function classifyTbUrl(url) {
  if (!url || typeof url !== 'string') return 'missing';
  let u;
  try { u = new URL(url); } catch (e) { return 'missing'; }
  const host = u.hostname.toLowerCase();
  if (host !== 'talkinbroadway.com' && !host.endsWith('.talkinbroadway.com')) return 'non-tb';
  const p = u.pathname.toLowerCase();
  if (p.includes('allthatchat') || p.endsWith('.php') || u.search) return 'forum';
  if (/\/index\.html?$/.test(p)) return 'index';
  if (/\.html?$/.test(p)) return 'review-page';
  return 'other-path';
}

function exclusionFlagOf(data) {
  for (const k of EXCLUSION_FLAGS) if (data[k]) return k;
  if (data.incompleteReason === 'permanently_unavailable') return 'permanently_unavailable';
  return null;
}

function fetchedAfterFix(data, fixDate) {
  const t = Date.parse(data.textFetchedAt || '');
  return Number.isFinite(t) && t >= Date.parse(fixDate || DEFAULT_FIX_DATE);
}

/**
 * Decide one file. Returns { eligible, reason }; reason is 'eligible' or the
 * first rule that dropped it.
 */
function classifyReview(data, { fixDate = DEFAULT_FIX_DATE } = {}) {
  if (!isStaleTbReview(data)) return { eligible: false, reason: 'not-stale' };
  const flag = exclusionFlagOf(data);
  if (flag) return { eligible: false, reason: `flag:${flag}` };
  const urlKind = classifyTbUrl(data.url);
  if (urlKind !== 'review-page') return { eligible: false, reason: `url:${urlKind}` };
  if (fetchedAfterFix(data, fixDate)) return { eligible: false, reason: 'fetched-after-fix' };
  return { eligible: true, reason: 'eligible' };
}

/**
 * entries: [{ showId, file, data }]. Returns counts and the sorted eligible
 * list ({ showId, file, url, contentTier }).
 */
function selectCandidates(entries, opts = {}) {
  const summary = { tbFiles: 0, stale: 0, eligible: 0, byReason: {}, byTier: {} };
  const candidates = [];
  for (const e of entries || []) {
    if (!e || !isTbFileName(e.file)) continue;
    summary.tbFiles++;
    if (!isStaleTbReview(e.data)) continue;
    summary.stale++;
    summary.byTier[e.data.contentTier] = (summary.byTier[e.data.contentTier] || 0) + 1;
    const { eligible, reason } = classifyReview(e.data, opts);
    summary.byReason[reason] = (summary.byReason[reason] || 0) + 1;
    if (eligible) candidates.push({ showId: e.showId, file: e.file, url: e.data.url, contentTier: e.data.contentTier });
  }
  candidates.sort((a, b) => (a.showId + '/' + a.file).localeCompare(b.showId + '/' + b.file));
  summary.eligible = candidates.length;
  return { summary, candidates };
}

/**
 * Split candidates into collect-review-texts.yml dispatch inputs. Each batch
 * sets show_filter too, so the run gets its own concurrency group and a fresh
 * progress state instead of queuing behind the global scheduled collector.
 */
function buildBatches(candidates, batchSize = 25) {
  const size = Math.max(1, Math.floor(Number(batchSize) || 25));
  const batches = [];
  for (let i = 0; i < (candidates || []).length; i += size) {
    const slice = candidates.slice(i, i + size);
    batches.push({
      count: slice.length,
      review_filter: slice.map((c) => `force:${c.showId}/${c.file}`).join(','),
      show_filter: [...new Set(slice.map((c) => c.showId))].join(','),
      max_reviews: String(slice.length),
    });
  }
  return batches;
}

module.exports = {
  STALE_TIERS,
  DEFAULT_FIX_DATE,
  EXCLUSION_FLAGS,
  isTbFileName,
  isStaleTbReview,
  classifyTbUrl,
  classifyReview,
  selectCandidates,
  buildBatches,
};
