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
const { offTopicSectionReason, listingPageUrlReason, nonReviewHostMatch } = require('./non-review-url-patterns');

// BRO-8023 (first batch promotions): Playbill /article/ pages are news (season
// boards, casting); 0 of 49,374 scored review urls are Playbill articles.
const PLAYBILL_ARTICLE_RE = /^https?:\/\/(?:www\.)?playbill\.com\/article\//i;
// A photo-call announcement ("production-images-released-for-grace-pervades-...").
// 0 scored urls match; a "first-look-theatre-..." review slug is left alone.
const ANNOUNCEMENT_SLUG_RE = /(?:^|[-/])(?:production-(?:images|photos|shots)-(?:released|revealed)|first-look-(?:at|photos|images|pictures))(?:-|\/|$)/i;

function hostKey(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return null; }
}
const _heldHostsMemo = new WeakMap();
/** Hosts with at least one scored review (from the held index's keys). */
function heldHosts(heldIndex) {
  if (!heldIndex) return new Set();
  if (!_heldHostsMemo.has(heldIndex)) _heldHostsMemo.set(heldIndex, new Set([...heldIndex.keys()].map((k) => k.split('/')[0])));
  return _heldHostsMemo.get(heldIndex);
}
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
  if (PLAYBILL_ARTICLE_RE.test(url)) return { verdict: 'junk', reason: 'Playbill news article, not a review' };
  if (ANNOUNCEMENT_SLUG_RE.test(url)) return { verdict: 'junk', reason: 'production-photo announcement, not a review' };
  // The census's non-review host list over-reaches on some hosts that do publish reviews (483 scored rows), so it
  // only settles a stub on a host the corpus has never scored a review from (venue sites such as bam.org).
  if (ctx.heldIndex && nonReviewHostMatch(url) && !heldHosts(ctx.heldIndex).has(hostKey(url))) {
    return { verdict: 'junk', reason: 'non-review host (venue/company site) with no scored review, not a review' };
  }
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
  // Aggregator stubs store prose dates ("December 14, 2014"): any parseable date naming a 4-digit year counts.
  const pdIso = stubDateIso(pd);
  if (ctx.show && pdIso && isArticleOutsideProductionWindow(ctx.show, pdIso)) {
    return { verdict: 'junk', reason: `article published ${pdIso} is outside this production's window (stub date, no fetch)` };
  }
  return { verdict: 'candidate', reason: null };
}

/**
 * A byline that is a member of the show's own creative team (the playwright on a
 * venue page: "William Shakespeare" on bam.org/Hamlet) means the page is about
 * the show, not a critic's review of it. Pure.
 */
function bylineIsShowCreator(byline, show) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const b = norm(byline);
  if (!b || b === 'unknown' || !show || !Array.isArray(show.creativeTeam)) return false;
  return show.creativeTeam.some((m) => m && norm(m.name) === b);
}

/** A stub's stored date as YYYY-MM-DD, or null when it is absent, unparseable or names no 4-digit year. Pure. */
function stubDateIso(pd) {
  const str = String(pd || '').trim();
  if (!str || !/(?:^|\D)(?:19|20)\d{2}(?:\D|$)/.test(str)) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T12:00:00Z` : str);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Era bucket of a show id by its year suffix (the queue report's slices). Pure. */
function showEra(showId) {
  const m = String(showId || '').match(/-(\d{4})$/);
  const y = m ? Number(m[1]) : 0;
  if (y >= 2025) return '2025-26';
  if (y >= 2015) return '2015-24';
  return 'pre-2015';
}

module.exports = { stubDateIso, bylineIsShowCreator, triagePendingStub, buildHeldUrlIndex, normalizeReviewUrl, isSettledPendingStub, showEra };
