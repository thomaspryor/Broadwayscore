'use strict';

/**
 * playbill-cache-guard.js — may this URL be WRITTEN to data/playbill-urls.json
 * as the Playbill page for this show? (BRO-2893)
 *
 * The cache is durable and keyed by show id, and validate-show-venue.js's
 * findPlaybillUrl() returns a cached URL BEFORE the scorer runs. So the
 * BRO-2821 matcher, which only guarded the READ path, could not undo a wrong
 * attribution once a writer had minted it: the entry was returned forever. The
 * guard therefore sits on the WRITE, inside playbill-urls-store.js, so every
 * writer (four today: discover-playbill-urls, fetch-show-images-auto,
 * enrich-off-broadway-dates, validate-show-venue) and any future one gets it
 * without opting in.
 *
 * It is the scorer's hard filters only, not its ranking:
 *   - the title test is playbillUrlTitleMatch (the same matcher scorePlaybillUrl
 *     uses), with the corpus venue slugs so the legacy vault/season branch works;
 *   - isCrossMarketPlaybillUrl (the read-side self-heal's predicate), so a
 *     London show can never again be cached to a New York production;
 *   - a regional/tour Playbill page only for a regional or tour show (the
 *     much-ado-about-nothing-2026 shape from CI run 34000023372).
 *
 * It judges NEW sets only. Existing entries are never re-judged here, because
 * the matcher's own docblock records that "anything the scorer dislikes" would
 * evict correct legacy entries (Moulin Rouge's vault URL is the known miss).
 * A refused write costs at most a SERP re-resolve next run; a wrong write cost
 * a permanently wrong validation.
 */

const { playbillUrlTitleMatch, venueSlug, classifyMarketTail } = require('./playbill-title-match');
const { isCrossMarketPlaybillUrl } = require('./playbill-url-market');

function knownVenueSlugsFor(shows) {
  const slugs = new Set();
  for (const s of shows || []) {
    const v = venueSlug(s && s.venue);
    if (v) slugs.add(v);
  }
  return slugs;
}

/**
 * @param {object} show a shows.json entry (needs title, category, venue)
 * @param {string} url  the Playbill production URL a writer wants to cache
 * @param {{knownVenueSlugs?: Set<string>}} [opts]
 * @returns {{ok: boolean, reason: string|null}}
 */
function playbillCacheWriteVerdict(show, url, opts = {}) {
  if (!show || !show.title) return { ok: false, reason: 'unknown-show' };
  if (typeof url !== 'string' || !url.includes('playbill.com/production/')) {
    return { ok: false, reason: 'not-a-production-url' };
  }
  if (isCrossMarketPlaybillUrl(url, show)) return { ok: false, reason: 'cross-market' };
  const tm = playbillUrlTitleMatch(url, show, { knownVenueSlugs: opts.knownVenueSlugs });
  if (!tm.match) return { ok: false, reason: 'title-mismatch' };
  const { market } = classifyMarketTail(tm.marketTail);
  if (market === 'regional' && show.category !== 'regional' && show.category !== 'tour') {
    return { ok: false, reason: 'regional-page-for-non-regional-show' };
  }
  return { ok: true, reason: null };
}

/**
 * Build the per-set guard the store calls, over one corpus read.
 * An id with no shows.json entry is REFUSED: nothing can be verified about it,
 * and a cache entry keyed by an id the corpus does not know is never read.
 */
function buildPlaybillCacheGuard(shows) {
  const list = Array.isArray(shows) ? shows : ((shows && shows.shows) || []);
  const byId = new Map(list.filter((s) => s && s.id).map((s) => [s.id, s]));
  const knownVenueSlugs = knownVenueSlugsFor(list);
  return (id, url) => playbillCacheWriteVerdict(byId.get(id), url, { knownVenueSlugs });
}

module.exports = { playbillCacheWriteVerdict, buildPlaybillCacheGuard, knownVenueSlugsFor };
