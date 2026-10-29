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
const { textMentionsTitle, normalizeForMention } = require('./show-title-variants');
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

/** Show rows each census market matches against (BRO-6488). Regional and tour rows are US. */
const SHOW_MARKETS = { nyc: NYC_MARKETS, london: new Set(['west-end']) };

function isMarketShow(show, market = 'nyc') {
  if (!show) return false;
  const set = SHOW_MARKETS[market] || NYC_MARKETS;
  return set.has(show.market || 'broadway');
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
  if (w) return pub >= w[0] && pub <= w[1];
  // No dates yet (a just-catalogued 2026 return): the id's year is still a floor, so an
  // earlier production's reviews are not filed against it (BRO-6481, Counting and Cracking).
  const year = /-(\d{4})$/.exec(show.id || '');
  if (!year) return true;
  const y = Number(year[1]);
  if (pub < Date.UTC(y, 0, 1) - PRE_START_DAYS * DAY_MS) return false;
  // An undated past production (263 West End rows carry only the id year) is not still
  // running a decade later: cap it two years past the id year (BRO-6488).
  // Announced or upcoming rows may still open late, so they keep no ceiling.
  if (/^(announced|upcoming|previews)$/i.test(show.status || '')) return true;
  return y >= new Date().getUTCFullYear() || pub < Date.UTC(y + 2, 0, 1);
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

// London (BRO-6488). Venue names alone ("Almeida", "Donmar") are London signals; a UK city,
// a tour, Edinburgh or New York in the text marks another production of the same title.
const LONDON_SIGNAL_RE = /\b(west end|off-west end|london|national theatre|\bthe national\b|olivier theatre|lyttelton|dorfman|almeida|donmar|(?<!bristol )old vic|young vic|royal court|hampstead theatre|bridge theatre|barbican|southwark playhouse|menier|park theatre|arcola|bush theatre|kiln theatre|tricycle|orange tree|lyric hammersmith|soho theatre|shakespeare'?s globe|sam wanamaker|trafalgar (?:theatre|studios)|regent'?s park|jermyn street|finborough|king'?s head|hope theatre|union theatre|the other palace|charing cross theatre|hackney empire|stratford east|theatre royal stratford|battersea arts centre|riverside studios|@sohoplace|sohoplace|marylebone theatre|hampstead|richmond theatre|wilton'?s music hall|the yard theatre|gate theatre|white bear|turbine theatre|omnibus|seven dials playhouse|pleasance london|vaudeville|gielgud|wyndham'?s|noel coward|harold pinter|duke of york'?s|apollo victoria|palladium|drury lane|lyceum|adelphi|savoy theatre|garrick|criterion|playhouse theatre|ambassadors|novello|aldwych|piccadilly theatre|prince edward|prince of wales theatre|dominion|phoenix theatre|cambridge theatre|her majesty'?s|haymarket|duchess theatre|fortune theatre|st martin'?s|apollo theatre|lyric theatre|shaftesbury theatre|victoria palace|peacock theatre|sadler'?s wells|coliseum|royal opera house|london palladium)\b/i;
const UK_OTHER_RE = /\b(broadway|off-broadway|new york|manhattan|brooklyn|manchester|salford|birmingham|leeds|sheffield|liverpool|bristol|bath|chichester|edinburgh|fringe|glasgow|dundee|aberdeen|pitlochry|cardiff|swansea|belfast|dublin|newcastle|gateshead|nottingham|leicester|derby|stratford-upon-avon|oxford|cambridge arts|brighton|(?<!duke of )york\b(?!'s| theatre)|coventry|northampton|plymouth|southampton|salisbury|watford|guildford|windsor|bolton|keswick|scarborough|ipswich|colchester|exeter|hull|frinton|harrogate|lancaster|clwyd|mold|milton keynes|stoke|wolverhampton|chester|canterbury|cheltenham|malvern|norwich|bury st edmunds|leatherhead|woking|basingstoke|bromsgrove|newbury|henley|lowry|new wolsey|crucible theatre|northern stage|royal exchange|home mcr|everyman|playhouse liverpool|curve theatre|curve leicester|royal & derngate|minerva|festival theatre|birmingham rep|the rep|west yorkshire playhouse|leeds playhouse|octagon|stephen joseph|theatr|traverse theatre|citizens theatre|tron theatre|lyceum edinburgh|king'?s theatre glasgow|grand opera house|abbey theatre|gate theatre dublin|theatre by the lake|mercury theatre|watermill|nuffield|new vic|hull truck|sheffield theatres|bristol old vic|tobacco factory|theatre royal bath|ustinov|chichester festival|yvonne arnaud|marlowe|wales millennium|sherman|torch theatre|storyhouse|uk tour|national tour|on tour|touring|tour\)|tour review|international tour|paris|berlin|avignon|sydney|melbourne|toronto|chicago|los angeles)\b/i;

const SIGNAL_MARKETS = {
  nyc: { home: NYC_SIGNAL_RE, other: OTHER_MARKET_RE, homeWins: /\bbroadway\b/i },
  london: { home: LONDON_SIGNAL_RE, other: UK_OTHER_RE, homeWins: /\b(?:west end|london)\b/i },
};

/** 'home' | 'other-market' | 'unknown' for the census market. */
function marketSignal(item, venues, market = 'nyc') {
  const m = SIGNAL_MARKETS[market] || SIGNAL_MARKETS.nyc;
  const hay = `${item.headline || ''} ${item.description || ''}`;
  // London: the headline names the venue and city ("X review – Royal Exchange,
  // Manchester"); a standfirst's "after its Chichester run" must not outvote it.
  // The staged venue ("Hamlet review – Bristol Old Vic", "(Dominion Theatre)") decides
  // first: a West End house outvotes a city in the play's title ("An American in Paris").
  const hint = market === 'london' ? venueHint(item.headline) : null;
  if (hint) {
    if (m.other.test(hint) && !m.homeWins.test(hint)) return 'other-market';
    if (m.home.test(hint)) return 'home';
  }
  const otherHay = market === 'london' && item.headline && (m.other.test(item.headline) || m.home.test(item.headline)) ? item.headline : hay;
  if (m.other.test(otherHay) && !m.homeWins.test(otherHay)) return 'other-market';
  if (m.home.test(hay)) return 'home';
  const low = hay.toLowerCase();
  if (venues && venues.some((v) => v && low.includes(v))) return 'home';
  return 'unknown';
}

function nycSignal(item, nycVenues) {
  const hay = `${item.headline || ''} ${item.description || ''}`;
  if (OTHER_MARKET_RE.test(hay) && !/\bbroadway\b/i.test(hay)) return 'other-market';
  if (NYC_SIGNAL_RE.test(hay)) return 'nyc';
  const low = hay.toLowerCase();
  if (nycVenues && nycVenues.some((v) => v && low.includes(v))) return 'nyc';
  return 'unknown';
}

/** Venue phrases of the market's shows, long enough not to collide with common words. */
function nycVenuePhrases(shows, market = 'nyc') {
  const set = new Set();
  for (const s of shows || []) {
    if (!isMarketShow(s, market) || !s.venue) continue;
    const v = String(s.venue).toLowerCase().replace(/\s*\(.*\)$/, '').trim();
    if (v.length >= 10) set.add(v);
  }
  return [...set];
}

/**
 * A one-word variant cut from a longer title ("David" from "David, A New Musical") must
 * stand alone in the headline: followed by punctuation, the end, a lowercase word, or the
 * title's own next word. A capitalized stranger makes it part of another name ("David
 * Geffen Hall", "Empire Records"). Title-case headlines capitalize every word, so a
 * capitalized function word or headline verb ("Empire Is", "Phantom Returns") still
 * counts as standing alone, as does a cut the headline writes in caps ("EMPIRE DELIVERS").
 * Any other capitalized follower ("Grenfell Looks at") leaves the item unmatched rather
 * than filed against the wrong show. If the raw headline never shows the variant (the
 * normalizer folds characters this regex does not), the match is kept.
 */
const HEADLINE_FOLLOWERS = new Set(('a an and are as at by does for from gets has hits in is isnt its makes ' +
  'of on opens or returns review reviews revival soars stuns takes the to was with dazzles delivers ' +
  'arrives comes lands shines falls fails struggles wows').split(' '));
function shortVariantStandsAlone(headline, title, variant) {
  const words = normalizeForMention(title).split(' ');
  if (variant.includes(' ') || words.length < 2) return true;
  const nextTitleWord = words[words.indexOf(variant) + 1];
  const raw = foldDiacritics(String(headline)).replace(/[‘’]/g, "'");
  // An all-caps headline carries no casing signal, so keep the match.
  if (!/[a-z]/.test(raw)) return true;
  const esc = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An all-lowercase headline (built from a URL slug) carries none either: the short
  // variant must lead it ("this beautiful future review" is not Beautiful, BRO-6488).
  if (!/[A-Z]/.test(raw)) return new RegExp(`^\\s*(?:review\\W+)?${esc}(?![a-z0-9])`, 'i').test(raw);
  const re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])(?:\\s+([a-z0-9']+))?`, 'gi');
  let seen = false;
  for (const m of raw.matchAll(re)) {
    seen = true;
    const next = m[1] && m[1].toLowerCase();
    const cutInCaps = variant.length > 1 && !/[a-z]/.test(m[0].slice(0, variant.length));
    if (!next || !/^[A-Z]/.test(m[1]) || next === nextTitleWord || cutInCaps
      || HEADLINE_FOLLOWERS.has(next.replace(/'/g, ''))) return true;
  }
  return !seen;
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
  const hits = shows.filter((s) => {
    if (!s.title || !runWindowMs(s) || !inRunWindow(s, item.publishDate)) return false;
    const v = textMentionsTitle(headline, s.title);
    return v && shortVariantStandsAlone(headline, s.title, v);
  });
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

/**
 * The show's title shows up only inside a venue name ("The Bridge" in "Guys and Dolls review,
 * Bridge Theatre"): strip the market's venue phrases and "<title> theatre", then re-check the
 * title words (BRO-6488: 16 false London Theatre gaps against the-bridge-off-west-end-2026).
 */
function titleOnlyInVenue(show, text, venues) {
  const t = normTitle(show && show.title).replace(/^the /, '');
  if (!t) return false;
  let hay = ` ${normTitle(text)} `;
  if (!hay.includes(` ${t} `)) return false;
  const phrases = [...(venues || []).map(normTitle), `${t} theatre`, `${t} theater`].filter((v) => v && ` ${v} `.includes(` ${t} `));
  if (!phrases.length) return false;
  for (const v of phrases.sort((a, b) => b.length - a.length)) hay = hay.split(` ${v} `).join(' | ');
  return !titleWordsAppear(show, hay);
}

const LEAD_FILLER = new Set(['theatre', 'theater', 'first', 'night', 'london', 'west', 'end', 'stage', 'musical', 'play', 'opera', 'dance', 'the']);
/** Normalised headline split at its first standalone "review": [before, after], or null. */
function splitAtReview(headline) {
  const hay = ` ${normTitle(headline)} `;
  const i = hay.indexOf(' review ');
  return i < 0 ? null : [hay.slice(0, i + 1), hay.slice(i + 7)];
}

/**
 * Slug headline "<title> <venue> review <tagline>": a title found only in the tagline is the
 * critic's phrasing ("misty bush theatre review ... how we tell stories" is not Stories;
 * "infamous jermyn street theatre review lady hamilton ..." is not Hamilton, BRO-6488).
 * A headline that opens with "review" (or "theatre review") has no lead and is left alone.
 */
function titleOnlyInTagline(show, headline) {
  const parts = splitAtReview(headline);
  if (!show || !parts) return false;
  const [before, after] = parts;
  if (!before.trim().split(' ').some((w) => w && !LEAD_FILLER.has(w))) return false;
  return !titleWordsAppear(show, before) && titleWordsAppear(show, after);
}

const VENUE_WORD_RE = /\b(theatre|theater|empire|playhouse|studios?|warehouse|hall|coliseum|palladium|arts centre|opera house)\b/;
/**
 * The headline names the production's venue right after the title, and it is not this
 * show's house ("aladdin hackney empire review" is a panto, not the Prince Edward Aladdin,
 * BRO-6488). Only a venue word between the title and "review" counts.
 */
function venueContradicts(show, headline) {
  if (!show || !show.venue) return false;
  const parts = splitAtReview(headline);
  const lead = parts ? parts[0] : ` ${normTitle(headline)} `;
  const t = normTitle(show.title).replace(/^the /, '');
  if (!t || !lead.includes(` ${t} `)) return false;
  const rest = lead.slice(lead.indexOf(` ${t} `) + t.length + 2).trim();
  if (!rest || !VENUE_WORD_RE.test(rest)) return false;
  // Compare word stems ("St Martin's" normalises to "martin", a slug says "martins"), and
  // let a National Theatre headline stand for its three houses.
  const stem = (w) => w.replace(/s$/, '');
  const restWords = new Set(rest.split(' ').map(stem));
  const venue = normTitle(show.venue);
  if (restWords.has('national') && /\b(olivier|lyttelton|dorfman|national)\b/.test(venue)) return false;
  const venueWords = venue.split(' ').filter((w) => w.length >= 3 && !['the', 'theatre', 'theater'].includes(w));
  return venueWords.length > 0 && !venueWords.some((w) => restWords.has(stem(w)));
}

/**
 * Sitemap lastmod days that are a bulk re-touch, not publish dates: one day carrying at
 * least minCount items and minShare of all of them (British Theatre Guide stamps 17,853
 * of 25,623 review URLs 2022-02, BRO-6488). Those lastmods must not become soft dates.
 */
function bulkLastmodDays(items, { minCount = 200, minShare = 0.1 } = {}) {
  const byDay = new Map();
  let n = 0;
  for (const i of items || []) {
    if (!i || !i.lastmod) continue;
    const d = String(i.lastmod).slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
    n++;
  }
  return new Set([...byDay].filter(([, c]) => c >= minCount && c >= n * minShare).map(([d]) => d));
}

function bucketItem(item, ctx) {
  const cls = classifyItem(item, { sourceSaysReview: !!item.sourceSaysReview });
  // aliasKey: the held URL an outlet's own id says is this page (WhatsOnStage moved every
  // /london-theatre/reviews/x_43290.html review to /news/x_43290/ and kept the number).
  const heldIds = ctx.corpus.get(urlKey(item.url)) || (item.aliasKey && ctx.corpus.get(item.aliasKey));
  const held = heldIds ? [...heldIds] : [];
  const nycHeld = held.filter((id) => ctx.nycIds.has(id));

  const matched = findMatchingShows(item.headline || '', slugOf(item.url), ctx.shows, item.description || '', { publishDate: item.publishDate || null });
  const matchText = `${item.headline || ''} ${slugOf(item.url)}`;
  // London only: the two headline-shape guards below were measured on the London corpus.
  const london = (ctx.market || 'nyc') !== 'nyc';
  const venueMismatchIds = [];
  const headlineFits = (s) => {
    // A show we already hold this URL under keeps its match: the guards are for gaps.
    if (!london || (heldIds && heldIds.has(s.id))) return true;
    if (titleOnlyInTagline(s, item.headline || '')) return false;
    if (venueContradicts(s, item.headline || '')) { venueMismatchIds.push(s.id); return false; }
    return true;
  };
  let inWindow = matched.filter((s) => inRunWindow(s, item.publishDate) && !titleOnlyInVenue(s, matchText, ctx.nycVenues) && headlineFits(s));
  let matchVia = inWindow.length ? 'poller-matcher' : null;
  if (inWindow.length === 0 && (cls.review || held.length)) {
    inWindow = variantMatches(item, ctx.shows).filter(headlineFits);
    if (inWindow.length) matchVia = 'title-variant';
  }
  const inIds = inWindow.map((s) => s.id);
  // A venue-mismatched show is another production, not an out-of-window one.
  const out = { bucket: null, classifyReason: cls.reason, matchVia, held, matchedIds: inIds, outOfWindowIds: matched.filter((s) => !inIds.includes(s.id) && !venueMismatchIds.includes(s.id)).map((s) => s.id) };
  if (venueMismatchIds.length) out.venueMismatchIds = [...new Set(venueMismatchIds)];

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
  const market = ctx.market || 'nyc';
  const sm = SIGNAL_MARKETS[market] || SIGNAL_MARKETS.nyc;
  const raw = marketSignal(item, ctx.nycVenues, market);
  const home = raw === 'home';
  const sig = home ? (market === 'nyc' ? 'nyc' : 'home') : raw;
  out.nycSignal = sig;
  // For those outlets a market word in the headline itself wins over "Broadway" in the
  // blurb ("'Putnam County Spelling Bee' at Kennedy Center", blurb: "the Broadway hit").
  const regionalOutletMiss = item.requireNycSignal && (!home || sm.other.test(item.headline || ''));
  // London keeps every other-market review in the manifest with its market, so the owner
  // can size a regional/touring/Edinburgh expansion (BRO-6488); NYC behaviour is unchanged.
  const otherBucket = market === 'nyc' ? 'not-review' : 'other-market-review';
  if (inIds.length && (sig === 'other-market' || regionalOutletMiss)) {
    out.bucket = otherBucket;
    out.classifyReason = sig === 'other-market' ? 'other-market' : 'no-nyc-signal';
    if (market !== 'nyc') Object.assign(out, itemMarket(item));
    return out;
  }
  if (inIds.length === 1) {
    const other = ctx.outletShowUrls && ctx.outletShowUrls.get(`${item.outletId}|${inIds[0]}`);
    out.bucket = other && other.length ? 'held-alt-url' : 'gap';
    if (other && other.length) out.altUrls = other.slice(0, 3);
    return out;
  }
  if (inIds.length > 1) { out.bucket = 'ambiguous'; return out; }
  // A London item naming a regional venue is an other-market review, whatever a same-titled
  // West End show's dates say ("Calendar Girls at New Wolsey Theatre").
  if (out.outOfWindowIds.length > 0 && !(market !== 'nyc' && sig === 'other-market')) { out.bucket = 'out-of-window'; return out; }
  out.bucket = home && !regionalOutletMiss ? 'catalog-gap' : sig === 'other-market' ? otherBucket : 'not-review';
  if (!home) out.classifyReason = sig === 'other-market' ? 'other-market' : 'no-nyc-signal';
  if (market !== 'nyc' && (out.bucket === 'catalog-gap' || out.bucket === 'other-market-review')) Object.assign(out, itemMarket(item));
  return out;
}

/**
 * Where an unmatched UK review was staged, for the catalog-gap summary (BRO-6488):
 * {itemMarket: west-end | off-west-end | london | edinburgh | touring | regional-uk | nyc |
 * international | unknown, venueHint}. The venue hint is the text after "review –" (Guardian,
 * Telegraph), "review at" (The Stage), or a parenthesis (WhatsOnStage), when present.
 */
const WEST_END_HOUSES_RE = /\b(gielgud|wyndham'?s|noel coward|harold pinter|duke of york'?s|apollo victoria|palladium|drury lane|lyceum|adelphi|savoy|garrick|criterion|playhouse theatre|ambassadors|novello|aldwych|piccadilly theatre|prince edward|prince of wales|dominion|phoenix theatre|cambridge theatre|her majesty'?s|his majesty'?s|haymarket|duchess|fortune theatre|st martin'?s|apollo theatre|lyric theatre|shaftesbury|victoria palace|sondheim theatre|queen'?s theatre|gillian lynne|new london theatre|london coliseum|vaudeville|sohoplace|old vic|national theatre|olivier|lyttelton|dorfman|barbican|bridge theatre|trafalgar theatre|theatre royal haymarket|peacock|savoy)\b/i;
function venueHint(headline) {
  const h = String(headline || '');
  const m = /\(([^)]{3,60})\)\s*$/.exec(h)
    || /\breview\b\s*[–—:|-]+\s*(.{3,80}?)\s*(?:[–—|]|$)/i.exec(h)
    || /\breview\s+(?:at|of [^,]+ at)\s+(.{3,80}?)\s*(?:[–—|]|$)/i.exec(h);
  return m ? m[1].trim() : null;
}
function itemMarket(item) {
  const head = String(item.headline || '');
  const hay = `${head} ${item.description || ''}`;
  const hint = venueHint(head);
  const v = `${hint || ''} ${head}`;
  let m = 'unknown';
  if (/\b(edinburgh|fringe)\b/i.test(head)) m = 'edinburgh';
  else if (/\b(uk tour|on tour|touring|tour\)|national tour|international tour)\b/i.test(head)) m = 'touring';
  else if (/\b(broadway|new york|off-broadway)\b/i.test(head)) m = 'nyc';
  // A city in the venue hint beats a house name it shares ("Lyceum, Sheffield", "Bristol Old Vic").
  else if (hint && UK_OTHER_RE.test(hint) && !/\b(?:west end|london)\b/i.test(hint)) m = /\b(paris|berlin|avignon|sydney|melbourne|toronto|chicago|los angeles)\b/i.test(hint) ? 'international' : 'regional-uk';
  else if (WEST_END_HOUSES_RE.test(v)) m = 'west-end';
  else if (LONDON_SIGNAL_RE.test(v)) m = 'off-west-end';
  else if (UK_OTHER_RE.test(head)) m = /\b(paris|berlin|avignon|sydney|melbourne|toronto|chicago|los angeles)\b/i.test(head) ? 'international' : 'regional-uk';
  else if (LONDON_SIGNAL_RE.test(hay)) m = 'london';
  return { itemMarket: m, venueHint: hint };
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

/** UK/US theatre season, September to August: 2013-10-02 -> "2013-14". */
function seasonOf(date) {
  const m = /^(\d{4})-(\d{2})/.exec(String(date || ''));
  if (!m) return 'undated';
  const y = Number(m[1]) - (Number(m[2]) < 9 ? 1 : 0);
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
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

/** Where a catalog-gap or other-market review would land: the venue, or the city for regional. */
function gapPlace(e) {
  const hint = String(e.venueHint || '').replace(/,?\s*(london|uk)\s*$/i, '').trim();
  return (hint || 'unknown venue').toLowerCase().replace(/\s+theatre$/, ' theatre');
}

/**
 * Catalog gaps grouped by market, then venue (or city), then year, with the review count each
 * would bring. Reviews of shows the site does not carry, summarised for the owner (BRO-6488:
 * no new shows outside the West End historical scope).
 */
function groupCatalogGaps(entries) {
  const out = {};
  for (const e of entries || []) {
    const m = e.itemMarket || 'unknown';
    const place = gapPlace(e);
    const year = String(e.publishDate || '').slice(0, 4) || 'undated';
    out[m] = out[m] || { reviews: 0, places: {} };
    out[m].reviews++;
    const p = (out[m].places[place] = out[m].places[place] || { reviews: 0, years: {}, outlets: {} });
    p.reviews++;
    p.years[year] = (p.years[year] || 0) + 1;
    p.outlets[e.outletId || '?'] = (p.outlets[e.outletId || '?'] || 0) + 1;
  }
  return out;
}

function catalogGapMarkdown(groups, topPlaces = 25) {
  const lines = ['| Market | Venue or city | Reviews | By year | Outlets |', '|---|---|---|---|---|'];
  for (const [m, g] of Object.entries(groups).sort((a, b) => b[1].reviews - a[1].reviews)) {
    lines.push(`| **${m}** | (all) | ${g.reviews} | | |`);
    const places = Object.entries(g.places).sort((a, b) => b[1].reviews - a[1].reviews);
    for (const [place, p] of places.slice(0, topPlaces)) {
      const years = Object.entries(p.years).sort().map(([y, n]) => `${y}:${n}`).join(' ');
      lines.push(`| ${m} | ${place.replace(/\|/g, '/')} | ${p.reviews} | ${years} | ${Object.keys(p.outlets).length} |`);
    }
    if (places.length > topPlaces) lines.push(`| ${m} | (${places.length - topPlaces} more) | ${places.slice(topPlaces).reduce((n, [, p]) => n + p.reviews, 0)} | | |`);
  }
  return lines.join('\n');
}

module.exports = {
  catalogGapMarkdown,
  groupCatalogGaps,
  slugHeadline,
  urlKey,
  titleWordsAppear,
  buildCorpusIndex,
  buildOutletShowIndex,
  decodeEntities,
  bucketItem,
  bulkLastmodDays,
  titleOnlyInVenue,
  titleOnlyInTagline,
  venueContradicts,
  classifyItem,
  corpusSideMisses,
  extractPageMeta,
  inRunWindow,
  isNycShow,
  isMarketShow,
  itemMarket,
  marketSignal,
  nycSignal,
  seasonOf,
  venueHint,
  nycVenuePhrases,
  runWindowMs,
  summarize,
  variantMatches,
};
