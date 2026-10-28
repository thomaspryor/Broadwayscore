'use strict';

/**
 * outlet-census.js (BRO-6481)
 *
 * Pure decision functions behind scripts/outlet-census.js. The pipeline goes show ->
 * find its reviews; the census flips it: outlet -> every theater review it published
 * -> which show -> do we hold it. That measures per-outlet recall and surfaces system
 * bugs the show-first audits are blind to (matcher misses, misfiled reviews, outlets
 * whose listings our pipeline cannot read).
 *
 * Buckets per enumerated item:
 *   held         we hold the URL under the show the matcher picks (or one of them)
 *   held-alt-url not held by URL, but we hold a review from this outlet for the one
 *                matched show under another URL (legacy URL scheme, redirect, syndication
 *                copy); counts as held for recall, listed so URL aliasing can be checked
 *   gap          the matcher names exactly one NYC show in its run window; we lack the URL
 *   misfile      we hold the URL, the matcher names other in-window show(s) but not ours
 *   held-unmatched  we hold the URL but the matcher finds no in-window show: a matcher
 *                gap (title variant, short title, common word), never a coverage gap
 *   ambiguous    not held; the matcher names 2+ in-window shows
 *   catalog-gap  not held, no show match, but the item reads as a NYC review: a
 *                production missing from shows.json, or a matcher miss (sampled)
 *   out-of-window  title matches a show but the date is outside every run window
 *                (a revival or tour we may not carry); reported, never a gap
 *   not-review   news/feature/roundup, or another market
 *
 * Recall for an outlet = (held + held-alt-url) / (held + held-alt-url + gap + misfile).
 */

const { findMatchingShows } = require('./outlet-listing-helpers');
const { urlKey } = require('./outlet-feed-reconcile');
const { toDateMs } = require('./date-utils');
const { textMentionsTitle } = require('./show-title-variants');
const { foldDiacritics } = require('./title-match');

const DAY_MS = 24 * 60 * 60 * 1000;
// A review can run before opening (press nights) and long after (cast-change re-reviews
// are still the same production); the floor is the earlier of previews and opening.
const PRE_START_DAYS = 30;
const POST_CLOSE_DAYS = 60;

const NYC_MARKETS = new Set(['broadway']);

function isNycShow(show) {
  return !!show && NYC_MARKETS.has(show.market || 'broadway');
}

/** [floorMs, ceilMs] for one production; ceil is Infinity while it runs. */
function runWindowMs(show) {
  const starts = [toDateMs(show.previewsStartDate || show.previewDate), toDateMs(show.openingDate)].filter((t) => !Number.isNaN(t));
  if (starts.length === 0) return null;
  const floor = Math.min(...starts) - PRE_START_DAYS * DAY_MS;
  const close = toDateMs(show.closingDate);
  const ceil = Number.isNaN(close) ? Infinity : close + POST_CLOSE_DAYS * DAY_MS;
  return [floor, ceil];
}

function inRunWindow(show, publishDate) {
  const pub = toDateMs(publishDate);
  if (Number.isNaN(pub)) return true; // undated: let the title decide, flag it later
  const w = runWindowMs(show);
  return !w || (pub >= w[0] && pub <= w[1]);
}

/**
 * url -> Set(showId) for everything we hold. Each entry: {showId, url, altUrls?}.
 * Review files (flagged or not) and reviews.json both feed it; a URL filed under two
 * shows keeps both ids.
 */
/** outletId|showId -> URLs we hold, for the held-alt-url check. */
function buildOutletShowIndex(entries) {
  const index = new Map();
  for (const e of entries || []) {
    if (!e || !e.showId || !e.outletId) continue;
    const k = `${e.outletId}|${e.showId}`;
    if (!index.has(k)) index.set(k, []);
    if (e.url && !index.get(k).includes(e.url)) index.get(k).push(e.url);
    else if (!e.url) index.get(k).push('(no url)');
  }
  return index;
}

function buildCorpusIndex(entries) {
  const index = new Map();
  for (const e of entries || []) {
    if (!e || !e.showId) continue;
    for (const u of [e.url, ...(Array.isArray(e.altUrls) ? e.altUrls : [])]) {
      if (!u) continue;
      const k = urlKey(u);
      if (!index.has(k)) index.set(k, new Set());
      index.get(k).add(e.showId);
    }
  }
  return index;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function metaContent(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html);
  if (a) return a[1];
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, 'i').exec(html);
  return b ? b[1] : null;
}

/**
 * Headline, publish date and description from an article page: og/meta tags first,
 * then JSON-LD. dateModified is only a fallback (NYTG pages carry nothing else) and is
 * marked so the report can say the date is soft.
 */
function extractPageMeta(html) {
  const s = String(html || '');
  const title = metaContent(s, 'og:title') || (/<title[^>]*>([^<]*)<\/title>/i.exec(s) || [])[1] || null;
  const description = metaContent(s, 'og:description') || metaContent(s, 'description');
  let date = metaContent(s, 'article:published_time') || (/"datePublished"\s*:\s*"([^"]+)"/.exec(s) || [])[1] || null;
  let dateSoft = false;
  if (!date) {
    date = metaContent(s, 'article:modified_time') || (/"dateModified"\s*:\s*"([^"]+)"/.exec(s) || [])[1] || null;
    dateSoft = !!date;
  }
  return {
    headline: title ? decodeEntities(title).trim() : null,
    description: description ? decodeEntities(description).trim() : null,
    publishDate: date ? String(date).slice(0, 10) : null,
    dateSoft,
  };
}

// Headline shapes that are lists, news or features, never one show's review.
const NOT_REVIEW_RE = /\b(best (?:of|shows|plays|musicals|theater|theatre)|top \d+|\d+ (?:best|shows|plays|musicals)|round-?up|what to see|shows to see|recap|interview|obituar|dies at|tony (?:award )?(?:nominations|predictions|winners)|announce[sd]?|cast(?:ing)? (?:announced|set)|first look|photos?:|video:|podcast|newsletter|gift guide)\b/i;
const BOOK_FILM_RE = /\b(book review|film review|movie review|tv review|album review|cast album|concert review|opera review|dance review|season \d+|episode|tony awards? (?:telecast|broadcast|ceremony|show)|the (?:\d{4}|\d+(?:st|nd|rd|th)(?: annual)?) tony awards|(?:pro-?shot|filmed|film|screen|movie) (?:capture|version|adaptation)|(?:on|streaming on) (?:disney\+|netflix|hbo|max|hulu|amazon|prime video|pbs|apple tv)|metropolitan opera|the met opera|\bat the met\b)\b/i;

/**
 * Is this item a theater review? `sourceSaysReview` is true when the enumeration source
 * already filters to reviews (a WP reviews category, a /reviews/ path).
 */
/** "https://x.com/article/theater-review-giant-broadway.html" -> "theater review giant broadway". */
function slugHeadline(url) {
  const last = String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '';
  return decodeURIComponent(last).replace(/\.(?:html?|php)$/i, '').replace(/[-_]+/g, ' ').trim();
}

function classifyItem(item, { sourceSaysReview = false } = {}) {
  const text = `${item.headline || ''} ${item.url || ''}`;
  if (NOT_REVIEW_RE.test(item.headline || '')) return { review: false, reason: 'list-or-news-headline' };
  if (BOOK_FILM_RE.test(text)) return { review: false, reason: 'other-medium' };
  if (sourceSaysReview) return { review: true, reason: 'source' };
  if (/\breview(?:ed|s)?\b/i.test(text.replace(/[-_/]/g, ' '))) return { review: true, reason: 'review-word' };
  return { review: false, reason: 'no-review-signal' };
}

const NYC_SIGNAL_RE = /\b(broadway|off-broadway|off broadway|new york|nyc|manhattan|brooklyn|lincoln center|public theater|signature theatre|playwrights horizons|second stage|roundabout|manhattan theatre club|mtc|atlantic theater|new york theatre workshop|nytw|lct3|vineyard theatre|the shed|park avenue armory|bam\b|st\.? ann'?s warehouse|soho rep|minetta lane|new world stages|lucille lortel|cherry lane|irish repertory|mcc theater|primary stages|keen company|theatre row|59e59|la mama|the kitchen|joe's pub|york theatre|pershing square signature|daryl roth|audible'?s minetta)\b/i;
const OTHER_MARKET_RE = /\b(west end|london|chicago|goodman|steppenwolf|los angeles|l\.a\.|pasadena|la jolla|old globe|san diego|san francisco|berkeley|seattle|boston|philadelphia|houston|dallas|atlanta|denver|minneapolis|guthrie|miami|washington,? d\.?c\.?|arena stage|kennedy center|shakespeare theatre company|hartford|new haven|yale rep|williamstown|berkshire|barrington|chautauqua|toronto|stratford|national tour|tour stop|edinburgh|chichester)\b/i;

function nycSignal(item, nycVenues) {
  const hay = `${item.headline || ''} ${item.description || ''}`;
  if (OTHER_MARKET_RE.test(hay) && !/\bbroadway\b/i.test(hay)) return 'other-market';
  if (NYC_SIGNAL_RE.test(hay)) return 'nyc';
  const low = hay.toLowerCase();
  if (nycVenues && nycVenues.some((v) => v && low.includes(v))) return 'nyc';
  return 'unknown';
}

/** NYC venue phrases long enough not to collide with common words. */
function nycVenuePhrases(shows) {
  const set = new Set();
  for (const s of shows || []) {
    if (!isNycShow(s) || !s.venue) continue;
    const v = String(s.venue).toLowerCase().replace(/\s*\(.*\)$/, '').trim();
    if (v.length >= 10) set.add(v);
  }
  return [...set];
}

/**
 * Second-stage match, census only: the poller's matcher deliberately skips common-word
 * titles (Giant, Soon, Just in Time) and needs the full catalog title ("Beaches, A New
 * Musical"), so a review headline that names the show plainly goes unmatched. Here the
 * item is already known to be a review and dated, so a headline that mentions a title
 * variant of a show whose run window holds the date is good evidence. Undated items
 * never take this path.
 */
function variantMatches(item, shows) {
  if (Number.isNaN(toDateMs(item.publishDate)) || !item.headline) return [];
  const headline = String(item.headline).replace(/^\s*[^:]{0,40}\breview\s*:\s*/i, '');
  const hits = shows.filter((s) => s.title && runWindowMs(s) && inRunWindow(s, item.publishDate) && textMentionsTitle(headline, s.title));
  // "Henry VI" and "Henry VI: A Trilogy" both hit: keep the longest titles only.
  const longest = Math.max(0, ...hits.map((s) => s.title.length));
  return hits.length > 1 ? hits.filter((s) => !hits.some((o) => o !== s && o.title.length > s.title.length && o.title.toLowerCase().includes(s.title.toLowerCase()))) : hits.filter((s) => s.title.length <= longest);
}

function slugOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || ''); }
}

/**
 * Bucket one enumerated item.
 * @param {Object} item       {url, headline, publishDate, description, sourceSaysReview}
 * @param {Object} ctx        {shows (NYC shows), allShows, corpus (buildCorpusIndex), nycVenues}
 */
const TITLE_STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'new', 'musical', 'play']);
function normTitle(t) {
  return foldDiacritics(String(t || '')).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[’']s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
/** Every significant word of the show's title (parenthetical included) appears in text. */
function titleWordsAppear(show, text) {
  if (!show) return false;
  // "School Girls; Or, The African Mean Girls Play": the main title alone is enough.
  const main = String(show.title || '').split(/\s*[;:]\s*|\s+[-–—]\s+/)[0];
  // Two words at least: a one-word main title ("Clara") is too loose to clear a misfile.
  if (main && main !== show.title && main.trim().split(/\s+/).length >= 2 && titleWordsAppear({ title: main }, text)) return true;
  const words = foldDiacritics(String(show.title || '')).toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !TITLE_STOP.has(w));
  if (!words.length) return false;
  const hay = ` ${foldDiacritics(String(text || '')).toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9]+/g, ' ')} `;
  return words.every((w) => hay.includes(` ${w} `));
}

function bucketItem(item, ctx) {
  const cls = classifyItem(item, { sourceSaysReview: !!item.sourceSaysReview });
  const heldIds = ctx.corpus.get(urlKey(item.url));
  const held = heldIds ? [...heldIds] : [];
  const nycHeld = held.filter((id) => ctx.nycIds.has(id));

  const matched = findMatchingShows(item.headline || '', slugOf(item.url), ctx.shows, item.description || '', { publishDate: item.publishDate || null });
  let inWindow = matched.filter((s) => inRunWindow(s, item.publishDate));
  let matchVia = inWindow.length ? 'poller-matcher' : null;
  if (inWindow.length === 0 && (cls.review || held.length)) {
    inWindow = variantMatches(item, ctx.shows);
    if (inWindow.length) matchVia = 'title-variant';
  }
  const inIds = inWindow.map((s) => s.id);
  const out = { bucket: null, classifyReason: cls.reason, matchVia, held, matchedIds: inIds, outOfWindowIds: matched.filter((s) => !inIds.includes(s.id)).map((s) => s.id) };

  if (held.length > 0) {
    if (nycHeld.length === 0) { out.bucket = 'held-other-market'; return out; }
    if (inIds.some((id) => heldIds.has(id))) out.bucket = 'held';
    else if (inIds.length > 0) {
      // The matcher can name another show while missing ours ("Innovative Touch to a
      // Top-Notch Othello" -> Touch, held under Bedlam's Othello). A held show whose
      // title words all appear is the matcher's miss, not a misfile, unless the matched
      // show has the SAME title (a different production: Illinoise Armory vs Broadway).
      const byId = new Map(ctx.shows.map((s) => [s.id, s]));
      const titleOf = (id) => normTitle((byId.get(id) || {}).title);
      const sameTitle = inIds.some((id) => nycHeld.some((h) => titleOf(h) && titleOf(h) === titleOf(id)));
      const named = nycHeld.some((h) => titleWordsAppear(byId.get(h), `${item.headline || ''} ${slugOf(item.url)}`));
      out.bucket = !sameTitle && named ? 'held' : 'misfile';
      if (out.bucket === 'held') out.matchVia = 'held-title-words';
    }
    else out.bucket = 'held-unmatched';
    return out;
  }
  if (!cls.review) { out.bucket = 'not-review'; return out; }
  // A regional or touring production of an NYC title ("HAMILTON (National Tour in
  // Houston)") matches the NYC show by title and date; it is not a review of it. Outlets
  // that mostly cover other markets (requireNycSignal) need a positive NYC signal.
  const sig = nycSignal(item, ctx.nycVenues);
  out.nycSignal = sig;
  // For those outlets a market word in the headline itself wins over "Broadway" in the
  // blurb ("'Putnam County Spelling Bee' at Kennedy Center", blurb: "the Broadway hit").
  const regionalOutletMiss = item.requireNycSignal && (sig !== 'nyc' || OTHER_MARKET_RE.test(item.headline || ''));
  if (inIds.length && (sig === 'other-market' || regionalOutletMiss)) {
    out.bucket = 'not-review';
    out.classifyReason = sig === 'other-market' ? 'other-market' : 'no-nyc-signal';
    return out;
  }
  if (inIds.length === 1) {
    const other = ctx.outletShowUrls && ctx.outletShowUrls.get(`${item.outletId}|${inIds[0]}`);
    out.bucket = other && other.length ? 'held-alt-url' : 'gap';
    if (other && other.length) out.altUrls = other.slice(0, 3);
    return out;
  }
  if (inIds.length > 1) { out.bucket = 'ambiguous'; return out; }
  if (out.outOfWindowIds.length > 0) { out.bucket = 'out-of-window'; return out; }
  out.bucket = sig === 'nyc' && !regionalOutletMiss ? 'catalog-gap' : 'not-review';
  if (sig !== 'nyc') out.classifyReason = sig === 'other-market' ? 'other-market' : 'no-nyc-signal';
  return out;
}

/** Corpus rows for the outlet, inside the census window, whose URL the enumeration never saw. */
function corpusSideMisses(corpusRows, enumeratedKeys, { sinceMs, untilMs = Infinity } = {}) {
  const misses = [];
  for (const r of corpusRows || []) {
    const pub = toDateMs(r.publishDate);
    if (!Number.isNaN(pub) && (pub < sinceMs || pub > untilMs)) continue;
    if (!r.url) { misses.push({ showId: r.showId, url: null, publishDate: r.publishDate || null, why: 'no-url' }); continue; }
    if (!enumeratedKeys.has(urlKey(r.url))) misses.push({ showId: r.showId, url: r.url, publishDate: r.publishDate || null, why: 'not-enumerated' });
  }
  return misses;
}

function summarize(results) {
  const counts = {};
  const viaTitleVariant = {};
  for (const r of results) {
    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
    if (r.matchVia === 'title-variant') viaTitleVariant[r.bucket] = (viaTitleVariant[r.bucket] || 0) + 1;
  }
  const heldAll = (counts.held || 0) + (counts['held-alt-url'] || 0);
  const denom = heldAll + (counts.gap || 0) + (counts.misfile || 0);
  // recallWithCatalog also counts NYC reviews of shows missing from the catalog as misses:
  // recall alone overstates coverage when the catalog is the gap (plan review 2026-10-28).
  const denomCat = denom + (counts['catalog-gap'] || 0);
  const ratio = (n, d) => (d ? Number((n / d).toFixed(3)) : null);
  return { counts, viaTitleVariant, recall: ratio(heldAll, denom), recallWithCatalog: ratio(heldAll, denomCat) };
}

module.exports = {
  slugHeadline,
  urlKey,
  titleWordsAppear,
  buildCorpusIndex,
  buildOutletShowIndex,
  decodeEntities,
  bucketItem,
  classifyItem,
  corpusSideMisses,
  extractPageMeta,
  inRunWindow,
  isNycShow,
  nycSignal,
  nycVenuePhrases,
  runWindowMs,
  summarize,
  variantMatches,
};
