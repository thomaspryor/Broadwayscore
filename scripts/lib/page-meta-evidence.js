'use strict';

/**
 * page-meta-evidence.js (BRO-5794) — count a real review whose full text can't
 * be fetched, using the evidence the page itself publishes above the wall:
 * og:title / <title>, og:description / meta description, JSON-LD headline and
 * author, published time.
 *
 * Owner rule 2026-10-20: a genuine review (known outlet, review URL, right
 * show and production, post-opening) must show on the site and count in the
 * score even when only a stub survives. Before this, such a stub had no text
 * signal, so explainExclusion() dropped it as 'noTextOrScoreSignal' (111 files
 * on 2026 shows, ~15 of them genuine reviews: Bachtrack Eugene Onegin, City
 * A.M. Ballad Lines, Albany Times Union Boop, ...).
 *
 * The evidence is stored in `metaExcerpt`, a member of EXCERPT_FIELDS, so every
 * consumer of the canonical excerpt list (rebuild inclusion, LLM scorer input,
 * text-quality, the cloned-excerpt guard) treats it like any other aggregator
 * excerpt: contentTier 'excerpt', confidence weight 0.5 in compute-critic-score.
 *
 * NEVER applies to non-reviews or the wrong show/production. The caller passes
 * the review-guards verdict (`exclusion`); only 'noTextOrScoreSignal' (every
 * other guard already passed, the file just has no text) is a candidate, and
 * the page must pass its own review/show/date checks on top.
 */

const { foldDiacritics } = require('./url-slug');

const MIN_EVIDENCE_CHARS = 50;
const MAX_EXCERPT_CHARS = 600;

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&rsquo;|&lsquo;|&#8217;|&#8216;|&#x2019;|&#x27;|&#39;|&apos;/g, "'")
    .replace(/&rdquo;|&ldquo;|&#8221;|&#8220;|&quot;/g, '"')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/g, '-')
    .replace(/&hellip;|&#8230;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Value of the first <meta> whose property/name/itemprop equals `key`. */
function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const id = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i);
    if (!id || id[1].toLowerCase() !== key) continue;
    const c = tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i);
    if (c) return decodeEntities(c[1]);
  }
  return null;
}

function jsonLdNodes(html) {
  const out = [];
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let parsed;
    try { parsed = JSON.parse(body); } catch { continue; }
    const stack = [parsed];
    while (stack.length) {
      const n = stack.pop();
      if (Array.isArray(n)) { stack.push(...n); continue; }
      if (!n || typeof n !== 'object') continue;
      out.push(n);
      if (n['@graph']) stack.push(n['@graph']);
    }
  }
  return out;
}

/**
 * Pull the page's own metadata. Every field is null when absent.
 * @returns {{headline, description, siteName, publishedTime, author, ratingValue, ratingBest}}
 */
function extractPageMeta(html) {
  const meta = { headline: null, description: null, siteName: null, publishedTime: null, author: null, ratingValue: null, ratingBest: null };
  if (!html || typeof html !== 'string') return meta;
  const titleTag = html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  meta.headline = metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || (titleTag ? decodeEntities(titleTag[1]) : null);
  meta.description = metaContent(html, 'og:description') || metaContent(html, 'description') || metaContent(html, 'twitter:description');
  meta.siteName = metaContent(html, 'og:site_name');
  meta.publishedTime = metaContent(html, 'article:published_time') || metaContent(html, 'datepublished');
  for (const n of jsonLdNodes(html)) {
    const type = [].concat(n['@type'] || []).join(',');
    if (!/Review|Article|NewsArticle|BlogPosting/i.test(type)) continue;
    if (!meta.headline && typeof n.headline === 'string') meta.headline = decodeEntities(n.headline);
    if (!meta.description && typeof n.description === 'string') meta.description = decodeEntities(n.description);
    if (!meta.publishedTime && typeof n.datePublished === 'string') meta.publishedTime = n.datePublished;
    if (!meta.author && n.author) {
      const a = [].concat(n.author)[0];
      const name = typeof a === 'string' ? a : (a && a.name);
      if (typeof name === 'string') meta.author = decodeEntities(name);
    }
    if (n.reviewRating && typeof n.reviewRating === 'object' && meta.ratingValue == null) {
      const v = parseFloat(n.reviewRating.ratingValue);
      const best = parseFloat(n.reviewRating.bestRating);
      if (Number.isFinite(v)) { meta.ratingValue = v; meta.ratingBest = Number.isFinite(best) ? best : 5; }
    }
  }
  if (meta.publishedTime) {
    const t = Date.parse(meta.publishedTime);
    meta.publishedTime = Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  }
  return meta;
}

// Boilerplate that shows up as a page's og:description when the real article is
// behind a wall, a cookie banner, a ticket widget or a site-wide tagline.
const CHALLENGE_PAGE = /\bjust a moment\b|\baccess denied\b|\bchecking your browser\b|\bverify you are human\b|\bpage not found\b/i;
const BOILERPLATE = [
  /\bview event details\b/i,
  /\bevent information supplied by\b/i,
  /\b(?:sign in|log in|subscribe|subscription|register)\b.{0,40}\b(?:to (?:read|continue|view|access)|now)\b/i,
  /\bcookies?\b/i,
  CHALLENGE_PAGE,
  /\bpage not found\b|\b404\b/i,
  /\b(?:home of|your (?:source|guide) (?:for|to)|latest (?:news|reviews)|(?:news|jobs),? (?:and |& )?(?:reviews|features|jobs|interviews))\b/i,
  /\bbuy tickets?\b|\bbook (?:now|tickets)\b|\btickets? (?:on sale|from)\b/i,
];

// A headline that names something other than a review of the production.
const NON_REVIEW_HEADLINE = /\b(?:interview|q\s*&\s*a|preview|first look|meets the press|casting|cast announce|photos?|tickets?|what to know|best (?:shows|plays|musicals)|review round-?\s?up|round-?\s?up|rehears(?:al|ing)|backstage|podcast|obituary|dies at|announces?)\b/i;

// Never a review of a stage production, whatever else the page says (games, TV,
// film, year-end lists, photo captions, roundups).
const ALWAYS_NON_REVIEW = /\b(?:video game|game review|pc game|playstation|xbox|nintendo|switch review|tv review|tv series|season \d+|episode|streaming|netflix|box office|film review|movie review|in cinemas|year in review|best of \d{4}|top \d+|photo credits?|photos? by|photograph by|review round-?\s?up|critics'? (?:picks|round-?\s?up)|\(\d{4} (?:film|movie)\)|(?:film|movie|tv|album|book)s?\b.{0,12}\breview|and more)\b/i;

// A headline that says "review" but is an interview/profile/list built around it.
const INTERVIEW_TEXT = /\b(?:in an? (?:lengthy |long |wide-ranging )?(?:chat|conversation|interview)|talks to|spoke to|speaks to|sits down with)\b|review:\s*[A-Z][\w.'-]+(?: [A-Z][\w.'-]+){1,2} (?:on|talks|discusses|reflects|reveals)\b/;
const REVIEW_WORD_NON_REVIEW = /\b(?:interview|in conversation|chat|talks|on the role|profile|reviews?:\s*[^,]+,[^,]+,)\b|^\s*theatre reviews?\s*:/i;

// Regional / foreign cities: a headline naming one is another production.
const OTHER_CITIES = /\b(?:stratford|edinburgh|manchester|bristol|leeds|birmingham|glasgow|sheffield|chichester|liverpool|cardiff|newcastle|oxford|cambridge|bath|brighton|nottingham|sydney|melbourne|toronto|chicago|boston|washington|philadelphia|los angeles|san francisco|dublin|paris|berlin)\b/i;

const REVIEW_WORD = /\breview(?:s|ed)?\b/i;
const RATING_TOKEN = /(?:\b[1-5](?:\.5)?\s*(?:\/|out of)\s*5\b|\b[1-5]\s*stars?\b|★|\bfive stars?\b|\bfour stars?\b|\bthree stars?\b)/i;

/** A run of star glyphs or "N stars" in the headline: the critic's own rating. */
function starRunRating(text) {
  const t = String(text || '');
  const run = t.match(/[★⭐]{1,5}/);
  if (run) return run[0].length;
  const m = t.match(/\b([1-5](?:\.5)?)\s*(?:\/\s*5\s*)?stars?\b/i) || t.match(/\b([1-5](?:\.5)?)\s*(?:\/|out of)\s*5\b/i);
  return m ? Number(m[1]) : null;
}

/** Distinctive words of a show title (folded, stop words and short words dropped). */
function showTokens(title) {
  const { titleTokens } = require('./show-match-verifier');
  return titleTokens(title);
}

/**
 * Does the evidence name this show? The title must appear as a contiguous
 * phrase (market words like "West End" / "Broadway" stripped, so a show called
 * "End" can't match "West End"). Long titles (4+ distinctive tokens) may match
 * 75% of tokens in headline + standfirst only. A one-word title must be in the
 * headline itself, not just a generic URL.
 */
const MARKET_WORDS = /\b(?:west end|off[- ]broadway|off off broadway|broadway|london|new york|nyc)\b/g;
function normalizeWords(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(MARKET_WORDS, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function evidenceNamesShow(show, headline, description, url) {
  const tokens = showTokens(show && show.title);
  if (!tokens.length) return false;
  const head = ` ${normalizeWords(headline)} `;
  // The page's own words only: a URL slug alone can't name the show (an outlet's
  // generic path would let any description through).
  const full = ` ${normalizeWords(`${headline || ''} ${description || ''}`)} `;
  const phrase = ` ${tokens.join(' ')} `;
  const plural = ` ${tokens.slice(0, -1).concat(`${tokens[tokens.length - 1]}s`).join(' ')} `;
  if (tokens.length === 1) {
    // "Cape Fear" is not "Fear": the title must open the headline or follow a
    // review/preposition/punctuation boundary, not another title word.
    const raw = foldDiacritics(String(headline || '')).toLowerCase();
    const re = new RegExp(`(^|[:'"\\u2018\\u201c\\-|]\\s*|\\b(?:review|reviews|reviewed|of|at|the|a|an|for|in)\\s+)${tokens[0]}s?\\b`);
    return re.test(raw) && (head.includes(phrase) || head.includes(plural));
  }
  if (full.includes(phrase) || full.includes(plural)) return true;
  if (tokens.length < 4) return false;
  const words = new Set(normalizeWords(`${headline || ''} ${description || ''}`).split(' '));
  const hit = tokens.filter((t) => words.has(t) || words.has(`${t}s`)).length;
  return hit >= Math.ceil(tokens.length * 0.75);
}

const NATIONAL = /\b(?:olivier|lyttelton|dorfman|cottesloe|national theatre)\b/;
const VENUE_GENERIC = new Set(['the', 'theatre', 'theater', 'playhouse', 'hall', 'studio', 'studios', 'at', 'of']);
/**
 * A venue named in the headline that shares nothing with the show's venue is a
 * different production (RSC Stratford vs the Old Vic). Unknown venue: no verdict.
 */
function venueConflicts(show, headline) {
  const venue = normalizeWords(show && show.venue);
  if (!venue) return false;
  const m = String(headline || '').match(/(?:,|\bat|@)\s+(?:the\s+)?([A-Z][\w'\u2019. -]{2,40}?\s(?:Theatre|Theater|Playhouse|Hall|Studios?|Court|Vic|Barbican|Playhouse))/);
  if (!m) return false;
  const named = normalizeWords(m[1]);
  if (NATIONAL.test(named) && NATIONAL.test(venue)) return false;
  const vt = venue.split(' ').filter((w) => w.length > 2 && !VENUE_GENERIC.has(w));
  const nt = named.split(' ').filter((w) => w.length > 2 && !VENUE_GENERIC.has(w));
  if (!vt.length || !nt.length) return false;
  return !nt.some((w) => vt.includes(w));
}

function cleanEvidenceText(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function buildMetaExcerpt(headline, description) {
  const h = cleanEvidenceText(headline).replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, (m) => (/review|[★⭐✭]/i.test(m) ? m : ''));
  const d = cleanEvidenceText(description);
  const joined = d && h && !d.toLowerCase().includes(h.toLowerCase()) ? `${h}. ${d}` : (d || h);
  return joined.length > MAX_EXCERPT_CHARS ? `${joined.slice(0, MAX_EXCERPT_CHARS - 3).replace(/\s+\S*$/, '')}...` : joined;
}

/**
 * Is this stub a candidate at all (before any fetch)?
 * @param {object} data - review-text record
 * @param {string|null} exclusion - explainExclusion(data, show, filePath) verdict
 * @returns {{ok: boolean, reason?: string}}
 */
function isMetaEvidenceCandidate(data, exclusion) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'no-data' };
  if (exclusion !== 'noTextOrScoreSignal') return { ok: false, reason: `exclusion:${exclusion || 'none'}` };
  if (data.fullText && String(data.fullText).trim()) return { ok: false, reason: 'has-fulltext' };
  if (!/^https?:\/\//i.test(String(data.url || ''))) return { ok: false, reason: 'no-url' };
  if (!data.outletId || /^unknown$/i.test(String(data.outletId))) return { ok: false, reason: 'unknown-outlet' };
  if (data.metaExcerpt) return { ok: false, reason: 'already-has-meta-excerpt' };
  return { ok: true };
}

/**
 * Judge the fetched page. Pure: no I/O.
 * @param {object} p
 * @param {object} p.data - review-text record
 * @param {object} p.show - shows.json entry
 * @param {object} p.meta - extractPageMeta() result
 * @param {(show: object, date: string) => boolean} p.inWindow - isReviewWithinOwnProductionWindow
 * @returns {{ok: boolean, reason?: string, excerpt?: string, publishDate?: string|null,
 *   criticName?: string|null, rating?: {value: number, best: number}|null}}
 */
function evaluatePageMeta({ data, show, meta, inWindow }) {
  if (!meta || !meta.headline) return { ok: false, reason: 'no-headline' };
  const headline = cleanEvidenceText(meta.headline);
  const description = cleanEvidenceText(meta.description);
  if (BOILERPLATE.some((re) => re.test(description)) || CHALLENGE_PAGE.test(headline)) {
    return { ok: false, reason: 'boilerplate' };
  }
  if (ALWAYS_NON_REVIEW.test(`${headline} ${description}`)) return { ok: false, reason: 'non-theatre-or-list' };
  const stars = starRunRating(headline);
  if (description.length < MIN_EVIDENCE_CHARS && !(stars && description.length >= 20)) return { ok: false, reason: 'description-too-short' };
  if (description.toLowerCase() === headline.toLowerCase()) return { ok: false, reason: 'description-is-headline' };
  if (NON_REVIEW_HEADLINE.test(headline) && !REVIEW_WORD.test(headline)) return { ok: false, reason: 'non-review-headline' };
  if (REVIEW_WORD_NON_REVIEW.test(headline) || INTERVIEW_TEXT.test(`${headline} ${description}`)) return { ok: false, reason: 'non-review-headline' };
  // The page's own words must signal a review; a URL slug or outlet-wide text can't.
  const reviewSignal = REVIEW_WORD.test(headline)
    || RATING_TOKEN.test(`${headline} ${description}`) || meta.ratingValue != null;
  if (!reviewSignal) return { ok: false, reason: 'no-review-signal' };
  if (!evidenceNamesShow(show, headline, description, data.url)) return { ok: false, reason: 'show-not-named' };
  if (venueConflicts(show, headline)) return { ok: false, reason: 'venue-mismatch' };
  const city = headline.match(OTHER_CITIES);
  if (city && !normalizeWords(`${show && show.venue} ${show && show.title}`).includes(city[0].toLowerCase())) return { ok: false, reason: 'other-city' };
  const date = meta.publishedTime || (/^\d{4}-\d{2}-\d{2}$/.test(String(data.publishDate || '')) ? data.publishDate : null);
  if (date) {
    if (!inWindow(show, date)) return { ok: false, reason: 'outside-production-window' };
  } else {
    // No date anywhere: the URL's own year decides (an old production's review
    // filed under a revival carries the old year in its path).
    const { extractDateFromUrl } = require('./rebuild-helpers');
    const urlDate = extractDateFromUrl(data.url);
    if (!urlDate) return { ok: false, reason: 'no-date' };
    if (!inWindow(show, urlDate)) return { ok: false, reason: 'url-date-outside-window' };
  }
  const excerpt = buildMetaExcerpt(headline, description);
  if (excerpt.length < MIN_EVIDENCE_CHARS) return { ok: false, reason: 'excerpt-too-short' };
  const rating = meta.ratingValue != null ? { value: meta.ratingValue, best: meta.ratingBest || 5 } : (stars ? { value: stars, best: 5 } : null);
  const author = meta.author && meta.author.length <= 60 && !/staff|editor|desk|team/i.test(meta.author) ? meta.author : null;
  const ratingSource = meta.ratingValue != null ? 'page-meta-jsonld' : 'page-meta-headline';
  return { ok: true, excerpt, publishDate: date, criticName: author, rating, ratingSource };
}

/**
 * Write the evidence onto the record (gap-fill only). Mutates `data`; returns
 * the list of fields set. Leaves the file a stub-free 'excerpt' tier record.
 */
function applyMetaEvidence(data, evidence, now = new Date()) {
  const set = [];
  if (!evidence || !evidence.ok) return set;
  data.metaExcerpt = evidence.excerpt; set.push('metaExcerpt');
  data.metaExcerptSource = 'page-meta';
  data.metaExcerptAt = now.toISOString();
  if (!data.manualContentTier) {
    data.contentTier = 'excerpt'; set.push('contentTier');
    data.contentTierReason = 'Full text unavailable; headline and standfirst from the page metadata (BRO-5794)';
  }
  if (evidence.publishDate && !data.publishDate) { data.publishDate = evidence.publishDate; data.publishDateSource = 'page-meta'; set.push('publishDate'); }
  const critic = String(data.criticName || '').trim();
  if (evidence.criticName && (!critic || /^unknown$/i.test(critic)) && !data.criticNameManual) {
    data.criticName = evidence.criticName; data.criticNameSource = 'page-meta'; set.push('criticName');
  }
  // A page-published numeric rating (JSON-LD reviewRating) is the critic's own
  // star; it still lands through the star-band rules in rebuild (score bands).
  if (evidence.rating && !data.originalScore && data.originalScoreCleared !== true && !data.originalScoreManual) {
    const { value, best } = evidence.rating;
    if (best === 5 && value >= 1 && value <= 5) {
      data.originalScore = `${value}/5 stars`; data.originalScoreSource = evidence.ratingSource || 'page-meta-jsonld'; set.push('originalScore');
    }
  }
  return set;
}

module.exports = {
  extractPageMeta, evaluatePageMeta, applyMetaEvidence, isMetaEvidenceCandidate,
  buildMetaExcerpt, evidenceNamesShow, starRunRating, ALWAYS_NON_REVIEW, venueConflicts, MIN_EVIDENCE_CHARS, NON_REVIEW_HEADLINE, BOILERPLATE,
};
