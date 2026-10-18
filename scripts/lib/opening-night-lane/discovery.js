'use strict';
/**
 * Discovery pass for the opening-night lane (BRO-4783, epic BRO-4210; design:
 * docs/opening-night-autonomy-review-2026-09-28.md section 6, "Discovery every 2 minutes, cheap first").
 *
 * One pass asks the cheap sources, in order of how fast they update: BWW homepage -> Review Roundup, DTLI
 * homepage -> show page, outlet RSS feeds, and plain-curl sweeps of T1 outlet section indexes (index pages beat
 * search for paywalled outlets). SERP only after +3 hours and only for T1/T2 outlets still missing.
 *
 * WHY THIS MODULE IS STRICT. Whatever it admits is stamped as an aggregator-verified lane review, and the corpus
 * guards (non-review, wrong-production, scraper-garbage ...) stand down for those files. A false positive here is
 * written to disk with no second line of defence, so every candidate has to clear, in order:
 *   1. a usable URL: tracking parameters stripped, one canonical key per article, redirect wrappers refused;
 *   2. for an aggregator page's links: only the ARTICLE body (not nav, footer, rails or ads), only hosts that
 *      resolve to a KNOWN outlet (unknown hosts are reported, never ingested blind);
 *   3. not a news/gallery/interview/tag/author URL, and for feed and index finds a positive "review" signal;
 *   4. for feed and index finds: published within opening night +/- 1 calendar day (trust model).
 * Missing a review here costs little: the normal pipeline and the aggregators still catch it. Admitting a
 * non-review costs a wrong score on the live site.
 *
 * Everything that touches the network goes through an injected `fetchText(url)`, wrapped here in a per-fetch
 * timeout and an overall pass deadline. Adapters are isolated: one failing source is recorded in `errors` and
 * never stops the pass.
 *
 * A pass returns what is NEW: not on disk, not in the night's ledger (`seen`), and not a final rejection recorded
 * in `memo`. Reuse over rewrite: the BWW, DTLI and feed parsers and the outlet resolver are the existing ones.
 */
const fs = require('fs');
const path = require('path');
const { findBWWRoundupLinkOnHomepage } = require('../bww-homepage-scan');
const { findDTLIShowLinkOnHomepage } = require('../dtli-homepage-scan');
const { parseFeedItems, titleMatchesShow, urlSlugMatchesShow } = require('../rss-discovery');
const { resolveOutletFromUrl } = require('../review-normalization');
const { admitLaneCandidate } = require('./trust-model');
const ledger = require('./ledger');

const SERP_AFTER_MS = 3 * 60 * 60 * 1000;
const DEFAULT_MAX_DATE_CHECKS = 10;
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_PASS_DEADLINE_MS = 90000;
const MAX_SOURCES_PER_ADAPTER = 12; // feeds or index pages per pass
const MAX_DATE_CHECK_ATTEMPTS = 3;
const MAX_UNWRAP_TRIES = 3;

// Hosts an aggregator page links to that are never reviews: social, ticketing, ads, affiliates, search, aggregators.
const NON_REVIEW_HOSTS = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'linkedin.com',
  'pinterest.com', 'threads.net', 'bsky.app', 'reddit.com', 'google.com', 'apple.com', 'spotify.com', 'amazon.com',
  'amzn.to', 'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'adservice.google.com',
  'ticketmaster.com', 'telecharge.com', 'todaytix.com', 'ticketweb.com', 'seatgeek.com', 'stubhub.com',
  'broadway.com', 'luckyseat.com', 'goldstar.com', 'vividseats.com', 'viagogo.com',
  'broadwayworld.com', 'didtheylikeit.com', 'playbill.com', 'showscore.com', 'show-score.com', 'wikipedia.org', 'ibdb.com',
];
// Short links and feed/redirect wrappers: the real article is only known after a fetch, so they are refused.
const WRAPPER_HOSTS = [
  'feedproxy.google.com', 'feeds.feedburner.com', 'feedburner.google.com', 'news.google.com', 't.co', 'bit.ly',
  'ow.ly', 'lnkd.in', 'tinyurl.com', 'buff.ly', 'dlvr.it', 'trib.al', 'go.redirectingat.com', 'l.facebook.com',
];
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|msclkid|igshid|mc_eid|mc_cid|ref|ref_src|referrer|partner|emc|smid|smtyp|cmp|cid|ocid|campaign|spm|_ga|_gl|taid|at_medium|at_campaign|share|shared|amp|output|cmpid|intcmp|iid|sr_share|rss)$/i;
// URL path segments of pages that are not a review of one production.
const NON_REVIEW_SEGMENTS = new Set([
  'news', 'tag', 'tags', 'author', 'authors', 'category', 'categories', 'topic', 'topics', 'gallery', 'galleries',
  'photos', 'photo', 'slideshow', 'video', 'videos', 'podcast', 'podcasts', 'newsletter', 'newsletters', 'subscribe',
  'subscription', 'about', 'contact', 'tickets', 'interview', 'interviews', 'feature', 'features', 'preview', 'previews',
  'opinion', 'obituary', 'obituaries', 'live', 'search', 'login', 'signin', 'account', 'privacy', 'terms',
]);
// News-phrase words only. Plain nouns that can be a show's title ("Dead Outlaw", "The Lottery", "Ticket to Ride") are
// deliberately absent: rejecting them would drop real reviews of those shows.
const NON_REVIEW_SLUG = /\b(opens[-\s]tonight|extends|extension|extended|casting|cast[-\s]album|announces?|announced|first[-\s]look|photos?|photo[-\s]gallery|red[-\s]carpet|opening[-\s]night[-\s](?:photos|party|arrivals)|interview|q[-\s]?and[-\s]?a|behind[-\s]the[-\s]scenes|giveaway|obituary)\b/i;
const REVIEW_SIGNAL = /(\breview(?:s|ed)?\b|\bcritic'?s?[-\s]pick\b|\/reviews?\/|\b(?:\d|one|two|three|four|five)(?:\.5)?[-\s]stars?\b)/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const hostMatches = (host, list) => !!host && list.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * One canonical form per article: https, no www, tracking parameters dropped, remaining parameters sorted, no
 * fragment, no trailing slash, no AMP suffix. Returns null for redirect wrappers and anything unparseable: the real
 * article behind a wrapper is unknown, and guessing would split one review across two keys.
 */
function canonicalUrl(url) {
  let u;
  try { u = new URL(String(url).replace(/&amp;/g, '&').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!host || hostMatches(host, WRAPPER_HOSTS)) return null;
  u.protocol = 'https:';
  u.hostname = host;
  u.hash = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let p = u.pathname.replace(/\/amp\/?$/i, '').replace(/\/+$/, '');
  u.pathname = p === '' ? '/' : p;
  return u.toString().replace(/\/$/, '');
}

function resolveUrl(href, base) {
  try { return new URL(String(href).replace(/&amp;/g, '&').trim(), base).toString(); } catch { return null; }
}

/** The article body of a page: <article> when there is one, else <main>, else the body, with page chrome removed. */
function bodyScope(html) {
  let s = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|nav|footer|aside|header|form|iframe|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  const article = s.match(/<article\b[\s\S]*?<\/article>/i);
  if (article) return article[0];
  const main = s.match(/<main\b[\s\S]*?<\/main>/i);
  return main ? main[0] : s;
}

/** Every <a href> in `html`, resolved against `pageUrl`, with its visible text. */
function extractAnchors(html, pageUrl) {
  const out = [];
  const re = /<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const url = resolveUrl(m[1], pageUrl);
    if (url) out.push({ url, text: m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** Why a URL cannot be one production's review, or null when nothing rules it out. */
function nonReviewReason(url) {
  let u;
  try { u = new URL(url); } catch { return 'unparseable-url'; }
  if (u.pathname === '/' || u.pathname === '') return 'homepage';
  const segs = decodeURIComponent(u.pathname).toLowerCase().split('/').filter(Boolean);
  if (segs.some((s) => NON_REVIEW_SEGMENTS.has(s))) return 'non-review-path';
  const words = segs.join(' ').replace(/[-_]+/g, ' ');
  // An explicit "review" in the slug wins over a news word ("...-review-photos"): the review signal is the stronger claim.
  if (NON_REVIEW_SLUG.test(words) && !REVIEW_SIGNAL.test(words)) return 'non-review-slug';
  return null;
}

/** A positive review signal in the URL or the headline: required for feed and index finds. */
function hasReviewSignal(url, title) {
  return REVIEW_SIGNAL.test(`${title || ''} ${(() => { try { return decodeURIComponent(new URL(url).pathname); } catch { return ''; } })()}`.replace(/[-_]+/g, ' '));
}

/**
 * The outbound links an aggregator page cites, within its article body: other hosts only, none from the non-review
 * host list or redirect wrappers, no bare homepages. Returned canonical, in order, without duplicates.
 */
function extractCitedLinks(html, pageUrl, { excludeHosts = [] } = {}) {
  const pageHost = hostOf(pageUrl);
  const seen = new Set();
  const out = [];
  for (const a of extractAnchors(bodyScope(html), pageUrl)) {
    const host = hostOf(a.url);
    if (!host || host === pageHost || hostMatches(host, NON_REVIEW_HOSTS) || hostMatches(host, excludeHosts)) continue;
    const key = canonicalUrl(a.url);
    if (!key || seen.has(key) || nonReviewReason(key) === 'homepage') continue;
    seen.add(key);
    out.push({ url: key, rawUrl: a.url, text: a.text });
  }
  return out;
}

/** The article's publish time as an ISO string, from JSON-LD, article:published_time, itemprop or <time datetime>. */
function extractPublishDate(html) {
  const s = String(html || '');
  // Strongest source first, and the FIRST source present decides: falling through to a weaker one would let a
  // sidebar "related story" date stand in for the article's own.
  const tries = [
    [/"datePublished"\s*:\s*"([^"]+)"/i, s],
    [/<meta[^>]+(?:property|name)=["']article:published_time["'][^>]*content=["']([^"']+)["']/i, s],
    [/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']article:published_time["']/i, s],
    [/<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i, s],
    [/<time\b[^>]*\bdatetime=["']([^"']+)["']/i, bodyScope(s)],
  ];
  // Talkin' Broadway pages carry no structured data: the date is in the "Theatre Review by {Critic} - {Month D, YYYY}" byline.
  const tb = s.match(/Theatre Review by\s*(?:<[^>]*>\s*)*[A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*){0,3}\s*(?:<[^>]*>\s*)*-\s*(?:<[^>]*>\s*)*([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/);
  if (tb) tries.push([/^(.*)$/, tb[1]]);
  for (const [re, scope] of tries) {
    const m = scope.match(re);
    if (!m) continue;
    const raw = m[1].trim();
    const written = raw.match(/^([A-Z][a-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/);
    if (written) {
      const mo = MONTHS.indexOf(written[1].slice(0, 3).toLowerCase());
      return mo < 0 ? null : `${written[3]}-${String(mo + 1).padStart(2, '0')}-${String(written[2]).padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw) && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
    // No zone: the instant is unknown, but the calendar date the outlet wrote is safe inside a +/-1 day window.
    const day = raw.match(/^(\d{4}-\d{2}-\d{2})T/);
    return day ? day[1] : null;
  }
  return null;
}

// ---- adapters: { name, kind, phase, discover({ show, night, fetchText, limit }) -> candidates[] } ---------------
// candidate: { url, source: 'aggregator'|'outlet-index', aggregatorCited?, publishDate?, title?, needsDate?, via, outletId? }

function bwwRoundupAdapter({ homeUrl = 'https://www.broadwayworld.com/' } = {}) {
  return {
    name: 'bww-roundup', kind: 'aggregator', phase: 'cheap',
    async discover({ show, fetchText }) {
      const roundup = findBWWRoundupLinkOnHomepage(await fetchText(homeUrl), show.title);
      if (!roundup) return [];
      return extractCitedLinks(await fetchText(roundup), roundup).map((l) => ({ url: l.url, fetchUrl: l.rawUrl, title: l.text, source: 'aggregator', aggregatorCited: true, via: roundup }));
    },
  };
}

function dtliAdapter({ homeUrl = 'https://didtheylikeit.com/' } = {}) {
  return {
    name: 'dtli', kind: 'aggregator', phase: 'cheap',
    async discover({ show, fetchText }) {
      const page = findDTLIShowLinkOnHomepage(await fetchText(homeUrl), show);
      if (!page) return [];
      return extractCitedLinks(await fetchText(page), page).map((l) => ({ url: l.url, fetchUrl: l.rawUrl, title: l.text, source: 'aggregator', aggregatorCited: true, via: page }));
    },
  };
}

// The shared feed parser returns pubDate as a Date, parsed in the SERVER's zone when the feed wrote none, and an Atom
// <updated> is the last edit, not the publish time. Neither is a trustworthy instant, so the raw text is re-read:
//   - RSS pubDate / dc:date WITH a zone: the instant, used as is.
//   - zoneless RSS date, or any Atom <updated>: only the calendar day the feed wrote, as a fallback; the article page
//     decides the date (needsDate) and the fallback stands only when the page has none.
const ZONE_SUFFIX = /(Z|GMT|UTC?|UT|[ECMP][SD]T|[+-]\d{2}:?\d{2})\s*$/i;
function writtenDay(raw) {
  const iso = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const rfc = String(raw).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/);
  const mo = rfc ? MONTHS.indexOf(rfc[2].toLowerCase()) : -1;
  return mo < 0 ? null : `${rfc[3]}-${String(mo + 1).padStart(2, '0')}-${String(rfc[1]).padStart(2, '0')}`;
}
function feedDateInfo(raw, { atom }) {
  const text = String(raw || '').trim();
  if (!text) return { publishDate: null, fallbackDate: null, needsDate: true };
  if (!atom && ZONE_SUFFIX.test(text) && !Number.isNaN(Date.parse(text))) return { publishDate: new Date(text).toISOString(), fallbackDate: null, needsDate: false };
  return { publishDate: null, fallbackDate: writtenDay(text), needsDate: true };
}
/** parseFeedItems plus the date evidence above, keyed by the raw link of each item/entry block. */
function parseFeedEntries(xml) {
  const text = String(xml || '');
  const atom = text.includes('<feed') && text.includes('<entry');
  const dates = new Map();
  for (const m of text.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi)) {
    const block = m[2];
    const link = ((block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/) || block.match(/<link[^>]*href=["']([^"']+)["']/) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
    const grab = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')) || [])[1];
    const raw = atom ? (grab('updated') || grab('published')) : (grab('pubDate') || grab('dc:date'));
    const onlyPublished = atom && !grab('updated');
    if (link) dates.set(link, onlyPublished ? { ...feedDateInfo(raw, { atom: false }) } : feedDateInfo(raw, { atom }));
  }
  return parseFeedItems(text).map((it) => ({ ...it, date: dates.get(it.link) || feedDateInfo('', { atom }) }));
}

function rssAdapter({ feeds }) {
  return {
    name: 'rss', kind: 'feed', phase: 'cheap',
    async discover({ show, fetchText }) {
      const out = [];
      for (const feed of (feeds || []).slice(0, MAX_SOURCES_PER_ADAPTER)) {
        let items;
        try { items = parseFeedEntries(await fetchText(feed.url)); } catch { continue; } // one dead feed never hides the others
        for (const it of items) {
          if (!it.link) continue;
          // fuzzy: an outlet's own typo in headline + slug (CATERINA, BRO-4001).
          if (!titleMatchesShow(it.title, show.title, { fuzzy: true }) && !urlSlugMatchesShow(it.link, show.title, { fuzzy: true })) continue;
          out.push({ url: it.link, title: it.title, source: 'outlet-index', ...it.date, via: feed.name || feed.url, outletId: hostOf(it.link) === hostOf(feed.url) ? feed.outletId : undefined });
        }
      }
      return out;
    },
  };
}

/** Plain sweep of an outlet's own section index page(s): same-host links that name the show. Dates are confirmed per article. */
function sectionIndexAdapter({ outlets }) {
  return {
    name: 'section-index', kind: 'outlet-index', phase: 'cheap',
    async discover({ show, fetchText }) {
      const out = [];
      for (const o of (outlets || []).slice(0, MAX_SOURCES_PER_ADAPTER)) {
        let html;
        try { html = await fetchText(o.indexUrl); } catch { continue; }
        const host = hostOf(o.indexUrl);
        for (const a of extractAnchors(bodyScope(html), o.indexUrl)) {
          if (hostOf(a.url) !== host || new URL(a.url).pathname === new URL(o.indexUrl).pathname) continue;
          if (!titleMatchesShow(a.text, show.title, { fuzzy: true }) && !urlSlugMatchesShow(a.url, show.title, { fuzzy: true })) continue;
          out.push({ url: a.url, title: a.text, source: 'outlet-index', publishDate: null, needsDate: true, via: o.indexUrl, outletId: o.outletId });
        }
      }
      return out;
    },
  };
}

/** Show Score: the "Read more" outlet links on the show's critic-review tiles. Show-page-vouched, so aggregator claims. */
function showScoreAdapter({ urlMap = {}, allShows = [] } = {}) {
  return {
    name: 'show-score', kind: 'aggregator', phase: 'cheap',
    async discover({ show, fetchText }) {
      const ss = require('../show-score-discover');
      const page = ss.showScoreUrlForShow(show, urlMap, allShows);
      if (!page) return [];
      // fetchAllShowScoreReviewUrls swallows fetch errors; keep the first one so an outage is reported, not read as "no reviews".
      let firstError = null;
      const urls = await ss.fetchAllShowScoreReviewUrls(page, async (u) => { try { return await fetchText(u); } catch (e) { firstError = firstError || e; throw e; } });
      if (!urls.length && firstError) throw firstError;
      return urls.filter((u) => !hostMatches(hostOf(u), NON_REVIEW_HOSTS)).map((u) => ({ url: u, title: '', source: 'aggregator', aggregatorCited: true, via: page }));
    },
  };
}

/** Playbill Verdict: the category page -> this show's "Read the reviews" roundup -> the links it cites. */
function playbillVerdictAdapter() {
  return {
    name: 'playbill-verdict', kind: 'aggregator', phase: 'cheap',
    async discover({ show, fetchText }) {
      const { searchPlaybillVerdict } = require('../playbill-verdict-discover');
      const hit = await searchPlaybillVerdict(show, { fetchHtml: (u) => fetchText(u) });
      if (!hit) return [];
      return extractCitedLinks(await fetchText(hit.articleUrl), hit.articleUrl).map((l) => ({ url: l.url, fetchUrl: l.rawUrl, title: l.text, source: 'aggregator', aggregatorCited: true, via: hit.articleUrl }));
    },
  };
}

const unescapeJs = (v) => String(v).replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');

/**
 * The publisher URL behind a Google News wrapper page, or null. Only a URL on the item's own source host counts (the
 * wrapper's opaque token is never read, and a page full of unrelated links is not a destination): canonical, og:url,
 * meta refresh, a JS location, data-n-au, then a single distinct anchor.
 */
function publisherUrlFromWrapperPage(html, sourceUrl) {
  const sourceHost = hostOf(sourceUrl);
  if (!sourceHost) return null;
  const accept = (value) => {
    const u = resolveUrl(unescapeJs(value || ''), 'https://news.google.com/');
    const host = u && hostOf(u);
    if (!host || host === 'news.google.com' || !(host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`))) return null;
    return /^https?:/i.test(u) && nonReviewReason(u) !== 'homepage' ? u : null;
  };
  const s = String(html || '');
  const single = [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
    /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i, /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["']/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i,
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i, /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of single) { const u = accept((s.match(re) || [])[1]); if (u) return u; }
  const found = new Set();
  for (const m of s.matchAll(/data-n-au=["']([^"']+)["']/gi)) { const u = accept(m[1]); if (u) found.add(u); }
  for (const a of extractAnchors(s, 'https://news.google.com/')) { const u = accept(a.url); if (u) found.add(u); }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Google News RSS search. Every item link is a news.google.com wrapper: it is unwrapped through the item's own
 * <source url> host, and an item whose publisher cannot be resolved is dropped (the wrapper itself is never emitted).
 * Resolutions are cached for the process so a 2-minute loop does not re-open the same wrapper; a failed one is retried
 * up to MAX_UNWRAP_TRIES times. Fetches are capped per pass by `maxUnwrap`.
 */
function googleNewsAdapter({ maxUnwrap = 8 } = {}) {
  const resolved = new Map(); // wrapper link -> { url|null, tries }
  return {
    name: 'google-news', kind: 'feed', phase: 'cheap',
    async discover({ show, fetchText }) {
      const london = /west[-\s]?end|london/i.test(String(show.category || ''));
      const q = new URLSearchParams({ q: `"${show.title}" review`, hl: london ? 'en-GB' : 'en-US', gl: london ? 'GB' : 'US', ceid: london ? 'GB:en' : 'US:en' });
      const xml = await fetchText(`https://news.google.com/rss/search?${q}`);
      const out = [];
      let unwrapped = 0;
      for (const m of String(xml).matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
        const grab = (tag) => ((m[1].match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i')) || [])[1] || '').trim();
        const title = grab('title').replace(/&amp;/g, '&');
        const link = grab('link');
        const sourceUrl = ((m[1].match(/<source[^>]*\burl=["']([^"']+)["']/i) || [])[1] || '').trim();
        if (hostOf(link) !== 'news.google.com' || !sourceUrl || !resolveOutletFromUrl(sourceUrl)) continue; // unknown publishers are never ingested blind
        if (!titleMatchesShow(title, show.title, { fuzzy: true })) continue;
        let r = resolved.get(link);
        if (!r || (!r.url && r.tries < MAX_UNWRAP_TRIES)) {
          if (unwrapped >= maxUnwrap) continue;
          unwrapped++;
          let url = null;
          try { url = publisherUrlFromWrapperPage(await fetchText(link, { preferPlaywright: true, skipVerify: true }), sourceUrl); } catch { /* counted below */ }
          r = { url, tries: ((r && r.tries) || 0) + 1 };
          resolved.set(link, r);
        }
        if (!r.url) continue;
        const date = feedDateInfo(grab('pubDate'), { atom: false });
        out.push({ url: r.url, title, source: 'outlet-index', ...date, via: 'google-news' });
      }
      return out;
    },
  };
}

// Talkin' Broadway review pages are dated files, not slugs ("/page/ob/10_09_26.html"), and their link text is the show title
// with no "review" word, so the usual review-signal test cannot apply. The path shape stands in for it. The date comes from
// the page's "Theatre Review by ... - Month D, YYYY" byline (extractPublishDate), never from the filename.
const TB_REVIEW_PATH = /^\/page\/(?:ob|bwaybway|westend)\/\d{2}_\d{2}_\d{2}[a-z]?\.html?$/i;
function talkinBroadwayAdapter({ indexUrls = ['https://www.talkinbroadway.com/page/ob/index.html', 'https://www.talkinbroadway.com/page/bwaybway/index.html'] } = {}) {
  return {
    name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap',
    async discover({ show, fetchText }) {
      const out = [];
      let failures = 0;
      for (const indexUrl of indexUrls.slice(0, MAX_SOURCES_PER_ADAPTER)) {
        let html;
        try { html = await fetchText(indexUrl); } catch { failures++; continue; }
        for (const a of extractAnchors(bodyScope(html), indexUrl)) {
          let u; try { u = new URL(a.url); } catch { continue; }
          if (hostOf(a.url) !== 'talkinbroadway.com' || !TB_REVIEW_PATH.test(u.pathname)) continue;
          if (!titleMatchesShow(a.text, show.title, { fuzzy: true })) continue;
          out.push({ url: a.url, title: a.text, source: 'outlet-index', publishDate: null, needsDate: true, reviewSignalGiven: true, via: indexUrl, outletId: 'talkinbroadway' });
        }
      }
      if (failures && failures === Math.min(indexUrls.length, MAX_SOURCES_PER_ADAPTER)) throw new Error('every Talkin\' Broadway index failed');
      return out;
    },
  };
}

/**
 * Site-restricted web search for T1/T2 outlets still missing (phase 'serp': the pass only runs it after +3h). `search(query)`
 * is injected and returns [{url,title}]. `limit` caps both the SEARCHES run and the results returned, so a burst of
 * missing outlets cannot burn SERP credits. Results carry no trustworthy date: it is read from the article.
 */
function serpAdapter({ search, domainFor } = {}) {
  if (typeof search !== 'function') throw new Error('serpAdapter: search(query) is required');
  const domain = domainFor || ((id) => {
    if (/\./.test(String(id))) return String(id).replace(/^www\./, '');
    const o = require('../../../data/outlet-registry.json').outlets[id];
    return o && o.domain ? String(o.domain).replace(/^www\./, '') : null;
  });
  return {
    name: 'serp', kind: 'serp', phase: 'serp',
    async discover({ show, missingOutlets = [], limit = 5 }) {
      const out = [];
      let searches = 0; let failures = 0; let lastError = null;
      for (const id of missingOutlets) {
        if (searches >= limit || out.length >= limit) break;
        const dom = domain(id);
        if (!dom) continue;
        searches++;
        let results;
        try { results = await search(`site:${dom} "${show.title}" review`); } catch (e) { failures++; lastError = e; continue; }
        for (const r of results || []) {
          if (!r || !r.url || !(hostOf(r.url) === dom || (hostOf(r.url) || '').endsWith(`.${dom}`))) continue;
          if (!titleMatchesShow(r.title || '', show.title, { fuzzy: true }) && !urlSlugMatchesShow(r.url, show.title, { fuzzy: true })) continue;
          out.push({ url: r.url, title: r.title || '', source: 'outlet-index', publishDate: null, needsDate: true, via: 'serp', outletId: id.includes('.') ? undefined : id });
        }
      }
      if (searches && failures === searches) throw lastError;
      return out.slice(0, limit);
    },
  };
}

// ---- the pass --------------------------------------------------------------------------------------------------

/** SERP runs only once the lane has been up for 3 hours AND at least one T1/T2 outlet is still missing. */
function serpAllowed({ startedAt, now, missingOutlets = [], afterMs = SERP_AFTER_MS }) {
  const elapsed = new Date(now).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= afterMs && missingOutlets.length > 0;
}

/** Wrap a fetch so one hung request cannot hang the pass. The orphaned request is left to finish on its own. */
function withTimeout(fetchText, ms, remainingMs = () => Infinity) {
  return (url, opts) => {
    const budget = Math.min(ms, remainingMs());
    if (budget <= 0) return Promise.reject(new Error(`pass deadline reached before fetching ${url}`));
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`fetch timed out after ${budget}ms: ${url}`)), budget); });
    // The timer is cleared on settle, so it never keeps the process alive past a finished fetch.
    return Promise.race([Promise.resolve().then(() => fetchText(url, opts)), timeout]).finally(() => clearTimeout(timer));
  };
}

// Final rejections are remembered so they are not re-fetched every 2 minutes; a dateless candidate gets a few tries.
const FINAL_REASONS = new Set(['outside-night-window', 'non-review-path', 'non-review-slug', 'homepage', 'not-review-like', 'unknown-outlet-host', 'wrapped-url', 'unknown-source', 'not-cited-by-an-aggregator']);
const AGGREGATOR_FINAL = new Set(['non-review-path', 'non-review-slug', 'homepage', 'wrapped-url', 'unknown-outlet-host']);

/**
 * @param {object} args
 *   show {id,title}, night 'YYYY-MM-DD', now, startedAt (lane start), fetchText(url)->string, adapters[],
 *   seen Set<canonical url> (on disk + ledger), memo {rejected:{key:{reason,attempts}}} (mutated; persist between
 *   passes), timeZone, missingOutlets [] (T1/T2 outlets not yet captured), serpMax, maxDateChecks,
 *   fetchTimeoutMs, deadlineMs
 * @returns {{admitted, rejected, unknownHosts, errors, deferredDateChecks, serpRan, deadlineHit}}
 */
async function runDiscoveryPass({
  show, night, now = Date.now(), startedAt, fetchText: rawFetch, adapters = [], seen = new Set(), memo = { rejected: {} },
  timeZone, missingOutlets = [], serpMax = 5, maxDateChecks = DEFAULT_MAX_DATE_CHECKS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS, deadlineMs = DEFAULT_PASS_DEADLINE_MS,
} = {}) {
  if (!show || !show.title) throw new Error('runDiscoveryPass: show.title is required');
  if (typeof rawFetch !== 'function') throw new Error('runDiscoveryPass: fetchText is required');
  memo.rejected = memo.rejected || {};
  const startedMs = Date.now();
  // Every fetch, in every adapter, is capped by the time left in the pass, so a slow adapter cannot outrun the deadline.
  const fetchText = withTimeout(rawFetch, fetchTimeoutMs, () => deadlineMs - (Date.now() - startedMs));
  const overDeadline = () => Date.now() - startedMs > deadlineMs;
  const errors = [];
  const byKey = new Map();
  const rejected = [];
  const unknownHosts = new Set();
  let deadlineHit = false;

  const collect = (candidates, adapterName) => {
    for (const c of candidates || []) {
      if (!c || !c.url) continue;
      const key = canonicalUrl(c.url);
      if (!key) { rejected.push({ url: c.url, adapter: adapterName, reason: 'wrapped-url' }); continue; }
      const prior = byKey.get(key);
      const next = { ...c, url: key, fetchUrl: c.fetchUrl || c.url, adapter: adapterName }; // fetch the URL as the outlet published it; dedupe on the canonical form
      // The same article from several sources keeps the strongest claim: an aggregator citation beats an index sighting.
      if (!prior || (!prior.aggregatorCited && c.aggregatorCited)) byKey.set(key, next);
    }
  };

  for (const a of adapters.filter((x) => x.phase !== 'serp')) {
    if (overDeadline()) { deadlineHit = true; break; }
    try { collect(await a.discover({ show, night, fetchText }), a.name); } catch (e) {
      errors.push({ adapter: a.name, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  let serpRan = false;
  if (!deadlineHit && serpAllowed({ startedAt, now, missingOutlets })) {
    for (const a of adapters.filter((x) => x.phase === 'serp')) {
      if (overDeadline()) { deadlineHit = true; break; }
      try {
        // `limit` goes to the adapter so it can cap the SEARCHES it runs, not just trim what came back.
        collect((await a.discover({ show, night, fetchText, missingOutlets, limit: serpMax }) || []).slice(0, serpMax), a.name);
        serpRan = true;
      } catch (e) { errors.push({ adapter: a.name, error: String((e && e.message) || e).slice(0, 200) }); }
    }
  }

  const admitted = [];
  const deferredDateChecks = [];
  let dateChecks = 0;
  const reject = (c, key, reason) => {
    rejected.push({ url: c.url, adapter: c.adapter, reason });
    const prev = memo.rejected[key] || { attempts: 0 };
    memo.rejected[key] = { reason, attempts: prev.attempts + 1 };
  };
  // Candidates not tried yet go first, so the date-check cap rotates through the backlog instead of re-checking the
  // same first few every pass.
  const ordered = [...byKey.entries()].sort(([ka], [kb]) => ((memo.rejected[ka] || {}).attempts || 0) - ((memo.rejected[kb] || {}).attempts || 0));
  for (const [key, c] of ordered) {
    if (seen.has(key)) continue;
    const memoed = memo.rejected[key];
    // An aggregator citation overrides rejections that only concerned an index sighting (no review word, wrong day).
    const stands = memoed && (c.aggregatorCited ? AGGREGATOR_FINAL.has(memoed.reason) : FINAL_REASONS.has(memoed.reason));
    if (stands || (memoed && memoed.attempts >= MAX_DATE_CHECK_ATTEMPTS && !c.aggregatorCited)) continue; // decided before
    if (overDeadline()) { deadlineHit = true; deferredDateChecks.push(c.url); continue; }

    const bad = nonReviewReason(c.url);
    if (bad) { reject(c, key, bad); continue; }
    if (c.source === 'aggregator') {
      // An aggregator page lists many links; only ones on a KNOWN outlet's host are taken, the rest are reported.
      if (!resolveOutletFromUrl(c.url)) { unknownHosts.add(hostOf(c.url)); reject(c, key, 'unknown-outlet-host'); continue; }
    } else if (!c.reviewSignalGiven && !hasReviewSignal(c.url, c.title)) {
      reject(c, key, 'not-review-like'); continue;
    }

    let publishDate = c.publishDate || null;
    if (c.source === 'outlet-index' && !publishDate && c.needsDate) {
      if (dateChecks >= maxDateChecks) { deferredDateChecks.push(c.url); continue; } // tried first next pass: attempts is still 0
      dateChecks++;
      try { publishDate = extractPublishDate(await fetchText(c.fetchUrl || c.url)) || c.fallbackDate || null; } catch (e) {
        errors.push({ adapter: c.adapter, error: `date check ${c.url}: ${String((e && e.message) || e).slice(0, 150)}` });
        const prev = memo.rejected[key] || { attempts: 0 };
        memo.rejected[key] = { reason: 'date-check-failed', attempts: prev.attempts + 1 };
        deferredDateChecks.push(c.url);
        continue;
      }
    }
    const verdict = admitLaneCandidate({ source: c.source, aggregatorCited: c.aggregatorCited === true, publishDate, night, ...(timeZone ? { timeZone } : {}) });
    if (verdict.admit) admitted.push({ url: c.fetchUrl || c.url, key, source: c.source, adapter: c.adapter, via: c.via, publishDate, outletId: c.outletId || (resolveOutletFromUrl(c.url) || {}).outletId || null, reason: verdict.reason });
    else reject(c, key, verdict.reason);
  }
  return { admitted, rejected, unknownHosts: [...unknownHosts].filter(Boolean).sort(), errors, deferredDateChecks, serpRan, deadlineHit };
}

/**
 * The rejection memo survives a restart: without it a restarted lane re-fetches every final rejection once more, and the
 * date-check rotation starts over. A missing or torn file is an empty memo (fail open to re-checking, never to admitting).
 */
function memoPath(ledgerDir, show, night) { return ledger.ledgerPath(ledgerDir, show, night).replace(/\.jsonl$/, '.memo.json'); }
function loadMemo(ledgerDir, show, night) {
  try {
    const m = JSON.parse(fs.readFileSync(memoPath(ledgerDir, show, night), 'utf8'));
    return { rejected: m && typeof m.rejected === 'object' && m.rejected ? m.rejected : {} };
  } catch { return { rejected: {} }; }
}
function saveMemo(ledgerDir, show, night, memo) {
  const file = memoPath(ledgerDir, show, night);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ rejected: (memo && memo.rejected) || {} }));
  fs.renameSync(tmp, file); // atomic: a crash mid-write never leaves a torn memo
  return file;
}

/** The set of keys the lane must not emit again: the night's ledger plus URLs already on disk, all canonicalised. */
function loadSeen(ledgerDir, show, night, onDiskUrls = []) {
  const seen = new Set();
  for (const u of onDiskUrls || []) { const k = canonicalUrl(u); if (k) seen.add(k); }
  for (const ev of ledger.readLedger(ledgerDir, show, night).events) seen.add(ev.reviewKey);
  return seen;
}

/** Log each admitted URL as `discovered`. Ledger keys are canonical URLs so loadSeen sees them next pass. */
function recordDiscovered(ledgerDir, { show, night, admitted, now = Date.now() }) {
  for (const a of admitted) {
    ledger.appendEvent(ledgerDir, { show, night, reviewKey: a.key || canonicalUrl(a.url), stage: 'discovered', at: now, meta: { adapter: a.adapter, via: a.via || null, source: a.source, url: a.url } });
  }
  return admitted.length;
}

module.exports = {
  SERP_AFTER_MS, NON_REVIEW_HOSTS, WRAPPER_HOSTS, canonicalUrl, bodyScope, extractAnchors, extractCitedLinks, extractPublishDate,
  nonReviewReason, hasReviewSignal, bwwRoundupAdapter, dtliAdapter, rssAdapter, sectionIndexAdapter, showScoreAdapter, playbillVerdictAdapter, googleNewsAdapter, talkinBroadwayAdapter, serpAdapter,
  publisherUrlFromWrapperPage, parseFeedEntries, serpAllowed, memoPath, loadMemo, saveMemo,
  runDiscoveryPass, loadSeen, recordDiscovered,
};
