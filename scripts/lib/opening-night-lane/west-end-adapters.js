'use strict';
/**
 * The opening-night lane's West End aggregator adapters (BRO-5956): WestEndTheatre.com (WET), theatre.reviews, Stagedoor,
 * The Stage review round-ups and London Box Office (LBO). Until now the lane read only the Broadway aggregators, so a West
 * End night had no aggregator-cited candidates at all; the poller and gather-reviews read these five sources (blocks
 * 1d to 1h of opening-night-poller.js) but outside the lane.
 *
 * Each adapter is the lane's { name, kind, phase, discover({ show, night, fetchText }) } shape (discovery.js) and reuses
 * the poller's own discovery and parsing: discoverWetRoundupRows, discoverTrRoundupHtml + extractTheatreReviews,
 * thestage-fetch + thestage-extract, findLboRoundupInSitemap + extractReviewsFromLBO. Every fetch goes through the lane's
 * `fetchText` (its routed fetchPage, so the fetch recorder and a replay see every page), JSON endpoints included.
 *
 * Rules shared by all five:
 *   - a show outside the West End market gets [] with no fetch, so the list is safe to append for every night;
 *   - a round-up's links are admitted with no per-link date check (aggregatorCited), so the round-up itself must be dated
 *     within FALLBACK_PAGE_MAX_DAYS of the opening (discovery.pageDatedNear), else it is another production's page;
 *   - a round-up that matched the show but parsed to no review on a known outlet throws (layout change), as
 *     discovery.requireKnownOutletLinks does for BWW and Playbill, so the pass's errors name it;
 *   - the lane runs a pass every couple of minutes for hours, and these sources are paid fetches: each adapter re-reads
 *     at most once per `everyMs` (default 10 min); one failed run is retried on the next pass, a second in a row waits.
 *
 * Stagedoor's domain has redirected to a ticketing site since 2026-06-25 (scrape-stagedoor-critics.js checkStagedoorAlive).
 * Its adapter probes the homepage once per night and stands down when it is still gone. Its review rows never carried an
 * outlet URL, so a live Stagedoor gives the lane nothing to fetch: that case throws, so a revived site is reported.
 */
const discovery = require('./discovery');
const { laneMarket, outletInMarket } = require('./lane-sources');
const { resolveOutletFromUrl } = require('../review-normalization');

const DEFAULT_EVERY_MS = 10 * 60 * 1000;
const EXCERPT_MIN_CHARS = 50; // discovery.citedExcerpts' bounds: shorter is a label, longer is not an excerpt
const EXCERPT_MAX_CHARS = 1500;
const STAGEDOOR_HOME = 'https://stagedoor.com/';
const LBO_SITEMAP = 'https://www.londonboxoffice.co.uk/news-sitemap.xml';
const THESTAGE_LISTING = 'https://www.thestage.co.uk/review-round-ups';

const isWestEnd = (show) => laneMarket(show) === 'west-end';
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

/** JSON from a fetched body. A browser-rendered fetch can wrap it in <pre>; that is unwrapped once before giving up. */
function parseJsonBody(body, url) {
  const text = String(body == null ? '' : body).trim();
  try { return JSON.parse(text); } catch { /* try the wrapped form */ }
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(text);
  if (pre) {
    const inner = pre[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    try { return JSON.parse(inner); } catch { /* fall through */ }
  }
  throw new Error(`not JSON: ${url}`);
}

/** The poller libs take fetchPage(url) -> {content} and fetchJSON(url); both from the lane's one fetchText. */
function libFetchers(fetchText) {
  return {
    fetchPage: async (url) => ({ content: await fetchText(url) }),
    fetchJSON: async (url) => parseJsonBody(await fetchText(url), url),
  };
}

const quiet = () => {};

/**
 * Round-up rows -> lane candidates. A row with no http(s) URL (LBO's own review, a WET table row, every Stagedoor row) is
 * not a candidate: the lane fetches and scores an outlet's page. A row pointing back at the round-up itself is dropped.
 * Same-host links stay: The Stage's round-up cites The Stage's own review (thestage.co.uk/reviews/...), and the lane's
 * non-review checks (discovery.nonReviewReason, lane-guards) still judge every URL.
 */
function rowCandidates(rows, via, excerptField) {
  const out = [];
  const self = discovery.canonicalUrl(via);
  for (const r of rows || []) {
    const url = String((r && r.url) || '').trim();
    if (!/^https?:\/\//i.test(url) || (self && discovery.canonicalUrl(url) === self)) continue;
    const excerpt = String((r && r.excerpt) || '').replace(/\s+/g, ' ').trim();
    out.push({
      url, fetchUrl: url, title: [r.outlet, r.critic].filter((x) => x && x !== 'Unknown').join(' / '),
      source: 'aggregator', aggregatorCited: true, via,
      ...(excerptField && excerpt.length >= EXCERPT_MIN_CHARS ? { excerpts: { [excerptField]: excerpt.slice(0, EXCERPT_MAX_CHARS) } } : {}),
    });
  }
  return out;
}

/** As discovery.requireKnownOutletLinks: a matched round-up with no known-outlet review is a page the lane cannot read. */
function requireKnownOutletRows(candidates, pageUrl, name) {
  if (!candidates.some((c) => resolveOutletFromUrl(c.url) && !discovery.nonReviewReason(discovery.canonicalUrl(c.url) || c.url, { aggregatorCited: true }))) {
    throw new Error(`${name}: round-up ${pageUrl} parsed to ${candidates.length} cited link(s), no review on a known outlet; page layout changed?`);
  }
  return candidates;
}

/** A round-up page dated near this opening, else null (another production's page under the same title). */
function datedNear(html, show) {
  return discovery.pageDatedNear(html, show && show.openingDate);
}

/**
 * Wrap an adapter so it skips West End-less nights and re-reads at most once per `everyMs` after a clean run. The first
 * run that throws is retried on the next pass (a blip); a second failure in a row throttles like a clean run, so a source
 * that stays broken all night (The Stage without a login, a changed layout) is not a paid fetch every pass.
 */
function westEndOnly(adapter, { now = Date.now, everyMs = DEFAULT_EVERY_MS } = {}) {
  let lastRunAt = null;
  let failuresInRow = 0;
  return {
    ...adapter,
    async discover(args) {
      if (!isWestEnd(args && args.show)) return [];
      const t = now();
      if (lastRunAt !== null && failuresInRow !== 1 && t - lastRunAt < everyMs) return [];
      lastRunAt = t;
      try {
        const out = await adapter.discover(args);
        failuresInRow = 0;
        return out;
      } catch (e) {
        failuresInRow++;
        throw e;
      }
    },
  };
}

/** WestEndTheatre.com: the WP-API "Reviews" search, then the post's rows (table or rendered-page format). */
function wetRoundupAdapter() {
  return {
    name: 'wet-roundup', kind: 'aggregator', phase: 'cheap', fetchTimeoutMs: 45000,
    async discover({ show, fetchText }) {
      const { discoverWetRoundupRows } = require('../wet-roundup-discover');
      const stats = {};
      const found = await discoverWetRoundupRows(show, { ...libFetchers(fetchText), log: quiet, stats });
      if (!found) {
        // discoverWetRoundupRows swallows fetch errors; an outage must not read as "no round-up yet".
        if (stats.fetchErrors && !stats.titleMatchedPosts) throw new Error('wet-roundup: WP API search failed');
        if (stats.titleMatchedPosts) throw new Error(`wet-roundup: ${stats.titleMatchedPosts} matching post(s) parsed to no rows; page layout changed?`);
        return [];
      }
      const { rows, post } = found;
      const dated = post.date && Math.abs(Date.parse(post.date) - Date.parse(String(show.openingDate || '').slice(0, 10))) <= 7 * 86400e3;
      if (!dated) return [];
      const via = post.link || 'https://www.westendtheatre.com/';
      return requireKnownOutletRows(rowCandidates(rows, via, 'westEndTheatreExcerpt'), via, 'wet-roundup');
    },
  };
}

/** theatre.reviews: the constructed /reviews-roundup/ URLs, then its WP-API search, each cross-show guarded. */
function theatreReviewsAdapter() {
  return {
    name: 'theatre-reviews', kind: 'aggregator', phase: 'cheap', fetchTimeoutMs: 45000,
    async discover({ show, fetchText }) {
      const { discoverTrRoundupHtml } = require('../tr-roundup-discover');
      const found = await discoverTrRoundupHtml(show, { ...libFetchers(fetchText), log: quiet, stats: {} });
      if (!found || !datedNear(found.html, show)) return [];
      const { extractReviews } = require('../../scrape-theatre-reviews');
      return requireKnownOutletRows(rowCandidates(extractReviews(found.html, show.id), found.url, 'theatreReviewsExcerpt'), found.url, 'theatre-reviews');
    },
  };
}

/**
 * Production fetch for The Stage's registration-gated round-up: the saved login over plain HTTPS
 * (fetch-plain.fetchWithCookiesPlain), or null when this machine has no cookies for it.
 */
async function theStageCookieFetch(url) {
  const { fetchWithCookiesPlain } = require('../fetch-plain');
  return fetchWithCookiesPlain(url);
}

/**
 * The Stage: the round-up listing (then the article sitemap) for this show's round-up, then its "Outlet, ★★★" links.
 * The page is gated for logged-out readers; `fetchGated` (default: the saved login) is tried once when the lane's
 * fetch gets the gate. Still gated is an error, so a dead login is reported, not read as "no reviews".
 */
function theStageAdapter({ fetchGated = theStageCookieFetch } = {}) {
  return {
    name: 'thestage-roundup', kind: 'aggregator', phase: 'cheap', fetchTimeoutMs: 45000,
    async discover({ show, fetchText }) {
      const ts = require('../thestage-fetch');
      const { extractReviews } = require('../thestage-extract');
      const { wetPostTitleMatchesShow } = require('../wet-roundup-discover');
      const matching = (urls) => urls.filter((u) => {
        const m = /\/review-round-ups\/([a-z0-9-]+?)-review-round-up/i.exec(u);
        return m && wetPostTitleMatchesShow(m[1].replace(/-/g, ' '), show.title);
      });
      // The listing lives at /review-round-ups (LISTING_URL redirects there, and a routed fetch refuses a redirected
      // page as a url mismatch). A failed listing read falls through to the sitemap, which holds every round-up.
      let urls = [];
      try { urls = matching(ts.parseRoundupUrls(await fetchText(THESTAGE_LISTING))); } catch { /* sitemap below */ }
      if (!urls.length) {
        // Off the 20-newest listing: the article sitemap holds every round-up.
        for (const sm of ts.parseArticleSitemaps(await fetchText(ts.SITEMAP_INDEX)).slice(0, 2)) {
          urls = matching(ts.parseRoundupUrls(await fetchText(sm)));
          if (urls.length) break;
        }
      }
      for (const url of urls.slice(0, 2)) {
        let html = await fetchText(url);
        let rows = extractReviews(html, show.id);
        if (!rows.length && ts.classifyRoundupPage(html, 0) === 'gated' && fetchGated) {
          const behindLogin = await fetchGated(url);
          if (behindLogin) { html = behindLogin; rows = extractReviews(html, show.id); }
        }
        if (!datedNear(html, show)) continue;
        const state = ts.classifyRoundupPage(html, rows.length);
        if (state === 'gated') throw new Error(`thestage-roundup: ${url} served the registration gate (no working login cookies)`);
        if (state === 'challenge') throw new Error(`thestage-roundup: ${url} served a bot challenge`);
        return requireKnownOutletRows(rowCandidates(rows, url, 'theStageExcerpt'), url, 'thestage-roundup');
      }
      return [];
    },
  };
}

/** London Box Office: the news sitemap -> this show's round-up -> its rows. */
function lboRoundupAdapter() {
  return {
    name: 'lbo-roundup', kind: 'aggregator', phase: 'cheap', fetchTimeoutMs: 45000,
    async discover({ show, fetchText }) {
      const { findLboRoundupInSitemap } = require('../lbo-roundup-discover');
      const url = findLboRoundupInSitemap(await fetchText(LBO_SITEMAP), show);
      if (!url) return [];
      const html = await fetchText(url);
      const { validateRoundupPageTitle } = require('../show-matching');
      if (!validateRoundupPageTitle(html, show.title).ok || !datedNear(html, show)) return [];
      // BRO-3121: a page the run dates cannot vouch for is another production's.
      const prod = require('../aggregator-page-production').checkAggregatorPageProduction({ html, show });
      if (prod.outOfRun) return [];
      const { extractReviewsFromLBO } = require('../../scrape-london-box-office-roundups');
      return requireKnownOutletRows(rowCandidates(extractReviewsFromLBO(html, show.id, url), url, 'lboRoundupExcerpt'), url, 'lbo-roundup');
    },
  };
}

/** Is a fetched stagedoor.com homepage really Stagedoor? Off-domain final URL or canonical = the 2026 redirect. */
function stagedoorRetired(page) {
  const content = String((page && page.content) || '');
  if (page && page.finalUrl && hostOf(page.finalUrl) && !/(^|\.)stagedoor\.com$/.test(hostOf(page.finalUrl))) return true;
  const canon = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(content) || /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(content);
  if (canon && hostOf(canon[1]) && !/(^|\.)stagedoor\.com$/.test(hostOf(canon[1]))) return true;
  return !/stagedoor/i.test((/<title[^>]*>([^<]*)<\/title>/i.exec(content) || [])[1] || '');
}

/** Stagedoor: probe once per night; retired (the 2026 redirect) = stand down; alive = report it (no URL rows to give). */
function stagedoorAdapter() {
  let retired = false;
  return {
    name: 'stagedoor', kind: 'aggregator', phase: 'cheap',
    status: () => (retired ? 'retired' : 'unknown'),
    async discover({ fetchText }) {
      if (retired) return [];
      const page = await fetchText(STAGEDOOR_HOME, { withFinalUrl: true });
      if (stagedoorRetired(typeof page === 'string' ? { content: page } : page)) { retired = true; return []; }
      throw new Error('stagedoor: stagedoor.com answers as Stagedoor again; its critic rows carry no outlet URLs, so the lane has no reader for it');
    },
  };
}

/** The five, West End-gated and throttled, in pass order. `fetchGated` is The Stage's login fetch (null in a replay). */
function westEndAdapters({ now = Date.now, everyMs = DEFAULT_EVERY_MS, fetchGated } = {}) {
  return [
    wetRoundupAdapter(), theatreReviewsAdapter(), stagedoorAdapter(),
    theStageAdapter(fetchGated === undefined ? {} : { fetchGated }), lboRoundupAdapter(),
  ].map((a) => westEndOnly(a, { now, everyMs }));
}

/**
 * Is an admitted lane candidate a valid West End review? The lane's own write-side check (lane-guards.laneNonReviewReason)
 * plus: a known outlet the registry places in the West End market. Returns a reason, or null. Used by the fixture replay.
 */
function westEndCandidateProblem(candidate) {
  const url = candidate && (candidate.url || candidate.key);
  if (!url) return 'no url';
  const outlet = resolveOutletFromUrl(url);
  if (!outlet) return 'unknown outlet';
  if (!outletInMarket(outlet.outletId, 'west-end')) return `outlet ${outlet.outletId} is not in the West End market`;
  const { laneNonReviewReason } = require('./lane-guards');
  const { PROVENANCE_KEY } = require('./trust-model');
  const why = laneNonReviewReason({ url, outletId: outlet.outletId, [PROVENANCE_KEY]: { source: 'aggregator' } });
  return why || null;
}

module.exports = {
  DEFAULT_EVERY_MS, westEndAdapters, westEndOnly, wetRoundupAdapter, theatreReviewsAdapter, theStageAdapter, lboRoundupAdapter,
  stagedoorAdapter, stagedoorRetired, rowCandidates, parseJsonBody, westEndCandidateProblem, isWestEnd,
};
