'use strict';
/**
 * pending-triage.js (BRO-8023): classify a _pending stub WITHOUT fetching it.
 *
 * The drain (scripts/replay-pending-bylines.js) fetches one file at a time, so a
 * 16-minute slot never reached most of the 6,786-file queue: thousands of stubs
 * that a URL rule could settle for free sat next to real reviews waiting for a
 * fetch. This is the drain's pre-fetch step, pulled out so it is pure, testable
 * and runnable over the whole queue in one pass (`--triage-only`).
 *
 *   duplicate  url already filed for THIS show   -> drain's redundant-stub rule
 *   junk       never a review of this production -> tagged with a reason, KEPT
 *   candidate  needs a fetch (byline, show match, date) -> drain's promotion path
 *
 * Every junk rule is a shared guard (intake uses the same ones), never a copy.
 */
const { offTopicSectionReason, listingPageUrlReason } = require('./non-review-url-patterns');
const { isBlockedReviewUrl } = require('./domain-filters');
const { isArticleOutsideProductionWindow } = require('./date-guard');

/** host+path, lowercased, no www., no trailing slash, no query/hash. Pure. */
function normalizeReviewUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch { return null; }
}

/**
 * Map normalized url -> Set(showId) of every scored review (reviews.json rows;
 * a rebuild-excluded row is not "held"). Pure over the rows passed in.
 */
function buildHeldUrlIndex(reviewRows) {
  const idx = new Map();
  for (const r of reviewRows || []) {
    if (!r || !r.url || !r.showId) continue;
    for (const u of [r.url, r.previousUrl]) {
      const k = normalizeReviewUrl(u);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(r.showId);
    }
  }
  return idx;
}

const SETTLED_KEYS = ['promoteSkippedReason', 'rssIdentityRejected'];
/** A stub the drain already settled (it never fetches it again). Pure. */
function isSettledPendingStub(data) {
  return !!data && SETTLED_KEYS.some((k) => !!data[k]);
}

/**
 * @param {object} data  the _pending stub
 * @param {{showId:string, show?:object, heldIndex?:Map<string,Set<string>>}} ctx
 * @returns {{verdict:'duplicate'|'junk'|'candidate', reason:string|null, heldBy?:string[]}}
 */
function triagePendingStub(data, ctx = {}) {
  const url = data && data.url;
  if (!url) return { verdict: 'candidate', reason: null };
  const offTopic = offTopicSectionReason(url);
  if (offTopic) return { verdict: 'junk', reason: `${offTopic} URL, not a review` };
  const listing = listingPageUrlReason(url);
  if (listing) return { verdict: 'junk', reason: `${listing} URL, not a review` };
  if (isBlockedReviewUrl(url)) return { verdict: 'junk', reason: 'aggregator/listing/feature URL, not an outlet review' };
  const held = ctx.heldIndex && ctx.heldIndex.get(normalizeReviewUrl(url));
  if (held && held.size) {
    if (held.has(ctx.showId)) return { verdict: 'duplicate', reason: 'url already scored for this show', heldBy: [ctx.showId] };
    const others = [...held].sort();
    return { verdict: 'junk', reason: `url already scored under ${others.slice(0, 3).join(', ')}, not a review of this production`, heldBy: others };
  }
  // A date the stub already carries (site search / aggregator) settles a
  // same-title earlier or later production without a fetch; the drain applies
  // the identical canonical window to the fetched date.
  const pd = data.publishDate;
  if (ctx.show && pd && /^\d{4}-\d{2}-\d{2}/.test(String(pd)) && isArticleOutsideProductionWindow(ctx.show, pd)) {
    return { verdict: 'junk', reason: `article published ${String(pd).slice(0, 10)} is outside this production's window (stub date, no fetch)` };
  }
  return { verdict: 'candidate', reason: null };
}

/** Era bucket of a show id by its year suffix (the queue report's slices). Pure. */
function showEra(showId) {
  const m = String(showId || '').match(/-(\d{4})$/);
  const y = m ? Number(m[1]) : 0;
  if (y >= 2025) return '2025-26';
  if (y >= 2015) return '2015-24';
  return 'pre-2015';
}

module.exports = { triagePendingStub, buildHeldUrlIndex, normalizeReviewUrl, isSettledPendingStub, showEra };
