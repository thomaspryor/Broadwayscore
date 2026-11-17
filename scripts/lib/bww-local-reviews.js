'use strict';

/**
 * BRO-7683: BroadwayWorld's per-city review archive (/<region>/local-reviews/[N]) as a
 * coverage check for the US city hubs. Pure (no I/O); scripts/bww-regional-coverage.js fetches.
 *
 * Why: the DC, LA and Chicago hubs add productions only from the Theatre-In-X listing
 * (tic-daily.js), which shows a handful of current shows and skips the Kennedy Center as a
 * tour house. Washington National Opera's Nixon in China (reviewed on BroadwayWorld
 * 2026-11-16) never reached the site. BroadwayWorld's city archive lists every local review,
 * so a reviewed production with no shows.json row is a coverage gap we can see.
 *
 *   parseLocalReviews(html, region) -> [{ url, region, title, venue, date, author }]
 *   classifyReview(review, ctx)     -> { status, reason?, showId? }
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');
const { resolveMetroInfo, norm } = require('./venue-metro');

// Not theatre productions the site scores (dance, concerts, solo evenings, children's theatre).
const NOT_THEATRE_RE = /\b(ballet|dance theatre|dance company|compagnie|symphony|orchestra|philharmonic|chorus|choir|in concert|an (intimate )?evening with|songbook|live celebration|tribute concert|comedy tour|stand-?up)\b/i;
const KIDS_VENUE_RE = /\b(imagination stage|adventure theatre|children'?s theat(re|er)|kennedy center for young|family theat(re|er))\b/i;
// Resident producing companies that perform in a hub's tour houses: never skip them as tours.
const RESIDENT_COMPANY_RE = /\b(washington national opera|kennedy center theater productions|lyric opera of chicago|la opera|los angeles opera|center theatre group|boston lyric opera|san diego opera)\b/i;

const DAY = 86400000;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/** "Review: NIXON IN CHINA at Washington National Opera" -> { title, venue }. */
function splitHeadline(headline) {
  const h = decodeEntities(headline).replace(/\s+/g, ' ').trim().replace(/^(bww\s+)?reviews?\s*:\s*/i, '');
  // Titles are in capitals and venues in title case, so the first lowercase " at " is the split
  // ("SPARKED: THE VANISHING AT BUZZARD POINT at Rorschach Theatre").
  const i = h.indexOf(' at ');
  if (i < 0) return { title: h, venue: '' }; // venue-write-guard-ok: parsed headline part, never written to shows.json
  return { title: h.slice(0, i).trim(), venue: h.slice(i + 4).trim() }; // venue-write-guard-ok: parsed headline part, never written to shows.json
}

/**
 * The show title inside a BWW title segment. BWW capitalises the show name, so when the segment mixes cases
 * ("Kokandy Productions' JEKYLL & HYDE", "MELT : THE PLAY returns triumphantly to The Marilyn Theatre",
 * "DIRTY DANCING Presented by Broadway In Chicago") the longest run of capitalised words is the title.
 */
function cleanTitle(segment) {
  const s = String(segment || '').replace(/\s+/g, ' ').trim();
  if (!/[a-z]/.test(s)) return s.replace(/^['"‘’“”]+|['"‘’“”]+$/g, '').trim();
  const words = s.split(' ');
  const isCap = (w) => /[A-Z]/.test(w) && !/[a-z]/.test(w.replace(/['’]s$/, '')) && w.replace(/[^A-Za-z0-9]/g, '').length > 0;
  const glue = (w) => /^[&:+\-–,!.?0-9]+$/.test(w); // "&", ":", "-" and numbers sit inside a capitalised title
  let best = null;
  for (let i = 0; i < words.length; i++) {
    if (!isCap(words[i])) continue;
    let j = i;
    while (j + 1 < words.length && (isCap(words[j + 1]) || (glue(words[j + 1]) && j + 2 < words.length && isCap(words[j + 2])))) j++;
    const run = words.slice(i, j + 1).join(' ');
    const letters = run.replace(/[^A-Za-z]/g, '').length;
    if (letters >= 3 && (!best || letters > best.letters)) best = { run, letters };
    i = j;
  }
  if (!best) return s;
  return best.run.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9!?)]+$/g, '').trim();
}

/** Title-case an all-caps BWW title for display ("NIXON IN CHINA" -> "Nixon In China"). */
function displayTitle(t) {
  const s = String(t || '').trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s:(/-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

const DATE_FROM_URL = /-(\d{4})(\d{2})(\d{2})(?:[/?#]|$)/;

/**
 * Parse a /<region>/local-reviews/ page. Prefers the page's JSON-LD ItemList (headline, url,
 * datePublished, author); falls back to Review- article anchors, dated from the URL suffix.
 */
function parseLocalReviews(html, region) {
  const out = new Map();
  const add = (url, headline, date, author) => {
    if (!url || !/\/article\/(BWW-)?Review-/i.test(url)) return;
    if (region && !url.includes(`/${region}/article/`)) return;
    const key = url.split(/[?#]/)[0];
    if (out.has(key)) return;
    const m = key.match(DATE_FROM_URL);
    const d = (date && String(date).slice(0, 10)) || (m ? `${m[1]}-${m[2]}-${m[3]}` : null);
    const { title: segment, venue } = splitHeadline(headline);
    out.set(key, { url: key, region: region || null, title: cleanTitle(segment), headline: decodeEntities(headline).trim(), venue, date: d, author: author || null });
  };
  for (const m of String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch (_) { continue; }
    for (const node of [].concat(data)) {
      const items = node && node['@type'] === 'ItemList' ? node.itemListElement || [] : [];
      for (const li of items) {
        const it = (li && li.item) || li || {};
        add(it.url, it.headline || it.name || '', it.datePublished, it.author && it.author.name);
      }
    }
  }
  for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]*\/article\/(?:BWW-)?Review-[^"]*)"[^>]*>([^<]{4,300})<\/a>/gi)) {
    const url = m[1].startsWith('http') ? m[1] : `https://www.broadwayworld.com${m[1]}`;
    add(url, m[2], null, null);
  }
  return [...out.values()];
}

function toTime(d) {
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
}

/** Is the show's run plausibly the one reviewed on `date`? */
function runCovers(show, date) {
  const r = toTime(date);
  if (r == null) return true;
  const start = toTime(show.previewsStartDate) ?? toTime(show.openingDate);
  const end = toTime(show.closingDate);
  if (start != null && start > r + 45 * DAY) return false;
  if (start != null && start < r - 400 * DAY && (end == null || end < r - 30 * DAY)) return false;
  if (end != null && end < r - 30 * DAY) return false;
  return true;
}

function titleMatches(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return false;
  if (jaccard(ta, tb) >= 0.6) return true;
  // One title wholly inside the other ("Step Afrika's THE FRUITS OF OUR LABOR" vs "The Fruits of Our Labor").
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return small.size >= 2 && [...small].every((t) => big.has(t));
}

const STOP = new Set(['the', 'theatre', 'theater', 'company', 'center', 'centre', 'stage', 'productions', 'presents', 'at', 'of', 'and']);
const venueWords = (v) => new Set(norm(String(v || '').split(',')[0]).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
/** The review's venue and a row's venue name the same house ("Goodman Theatre" / "Goodman Theatre, Chicago, IL"). */
function sameHouse(reviewVenue, showVenue) {
  const a = venueWords(reviewVenue);
  const b = venueWords(showVenue);
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((w) => big.has(w));
}
const metroOf = (venue) => { const m = venue && resolveMetroInfo(venue); return m ? m.slug : null; };

/**
 * Classify one BWW review against shows.json for the hub `metro` (data/city-hubs.json slug).
 * ctx: { shows, metro, tourHouses: RegExp[], decisions?: { [url]: { decision } } }
 * status: covered | covered-tour | excluded | declined | tour-house | missing
 */
function classifyReview(review, ctx) {
  const { shows, metro, tourHouses = [], decisions = {} } = ctx;
  const text = `${review.title} ${review.venue}`;
  if (NOT_THEATRE_RE.test(`${text} ${review.headline || ''}`)) return { status: 'excluded', reason: 'not-theatre' };
  if (KIDS_VENUE_RE.test(review.venue)) return { status: 'excluded', reason: 'childrens-theatre' };
  // A row added from this very review (bww-review-add cites it in evidenceUrls) covers it, wherever the row is filed
  // (a Berkshires house gets its own city, so the hub/title match alone reports it missing every day).
  const cited = review.url && shows.find((s) => Array.isArray(s.evidenceUrls) && s.evidenceUrls.includes(review.url));
  if (cited) return { status: cited.category === 'tour' || cited.market === 'tour' ? 'covered-tour' : 'covered', showId: cited.id };
  const candidates = shows.filter((s) => runCovers(s, review.date) && titleMatches(s.title, review.title));
  // Local: a regional row in this hub, or in the metro its venue resolves to, or at the same house (BWW's LA page
  // reviews The Old Globe; Laguna Playhouse rows carry laguna-beach-ca).
  const local = candidates.find((s) => s.category === 'regional'
    && (s.city === metro || !s.city || metroOf(s.venue) === metro || sameHouse(review.venue, s.venue)));
  if (local) return { status: 'covered', showId: local.id };
  const resident = RESIDENT_COMPANY_RE.test(review.venue) || RESIDENT_COMPANY_RE.test(review.title);
  // A national tour in its run window is the touring production BWW reviewed, at a tour house or under a presenter
  // ("DIRTY DANCING Presented by Broadway In Chicago"), unless the venue is a resident company's own production.
  const tour = !resident && candidates.find((s) => s.category === 'tour' || s.market === 'tour');
  if (tour) return { status: 'covered-tour', showId: tour.id };
  const d = decisions[review.url];
  // An "exists" verdict holds only while that row does (a deleted row makes the review missing again).
  const stillThere = !d || d.decision !== 'exists' || shows.some((s) => s.id === d.showId);
  if (d && d.decision && d.decision !== 'add' && stillThere) return { status: 'declined', reason: d.decision };
  if (!resident && tourHouses.some((re) => re.test(review.venue))) return { status: 'tour-house', reason: 'touring production at a tour house' };
  return { status: 'missing' };
}

module.exports = {
  parseLocalReviews,
  classifyReview,
  splitHeadline,
  cleanTitle,
  sameHouse,
  displayTitle,
  titleMatches,
  runCovers,
  NOT_THEATRE_RE,
  RESIDENT_COMPANY_RE,
};
