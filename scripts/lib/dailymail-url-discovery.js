/**
 * Daily Mail review URL discovery (BRO-716).
 *
 * Theatre Record hands us Daily Mail / Mail on Sunday review TEXT with no URL.
 * Google does not index most of these pages and DM's own search is broken, so
 * the URL is found by text: list every article DM published around the review
 * date (its per-day HTML archive), fetch the theatre-looking ones, and keep the
 * page whose paragraphs contain the review's own sentences.
 *
 * DM bundles reviews: one article carries a lead review plus several short
 * secondary reviews of other shows, each under its own "Title (Venue)" /
 * "Rating: Four out of five stars" heading. So a match can sit mid-page, and
 * the page-level star extractor would read the LEAD show's rating. That is why
 * matches carry a placement and the rating is parsed from the matched
 * section's own heading.
 *
 * Pure functions only; I/O lives in scripts/discover-dailymail-urls.js.
 */

const { foldDiacritics: foldAccents } = require('./title-match');

const SHINGLE = 6;

function normWords(s) {
  return foldAccents(String(s || '')).toLowerCase()
    .replace(/&#x27;|&#39;|&#039;|’|‘/g, "'")
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(words, n = SHINGLE) {
  const s = new Set();
  for (let i = 0; i + n <= words.length; i++) s.add(words.slice(i, i + n).join(' '));
  return s;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

/** Article links on a DM sitemaparchive day page (relative paths, deduped). */
function parseDayArchive(html) {
  return [...new Set([...String(html || '').matchAll(/href="(\/[^"]*article-\d+\/[^"]*\.html)"/g)].map(m => m[1]))];
}

const THEATRE_SECTIONS = /^\/(tvshowbiz|tv|news|home\/event|debate|femail)\//;
const THEATRE_HINT = /review|theatre|stage|MARMION|GORE|LANGTON|GEORGINA|LETTS|COOK|BROWN|ARMSTRONG/;
const NOT_THEATRE = /film|movie|album|BRIAN-VINER|tv-review|STEVENS/i;

/** Cheap slug filter: could this article hold a theatre review? */
function isCandidatePath(p) {
  return THEATRE_SECTIONS.test(p) && THEATRE_HINT.test(p) && !NOT_THEATRE.test(p);
}

/** Title, byline, publish date and body paragraphs of a DM article page. */
function extractArticle(html) {
  const h = String(html || '');
  const title = decodeEntities((h.match(/<title>([^<]*)/) || [])[1] || '').trim();
  const author = (h.match(/name="author" content="([^"]*)"/) || [])[1] || null;
  const datePublished = (h.match(/"datePublished":"([^"]*)"/) || [])[1] || null;
  const paras = [...h.matchAll(/<p[^>]*class="[^"]*mol-para[^"]*"[^>]*>([\s\S]*?)<\/p>/g)]
    .map(m => decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  return { title, author, datePublished, paras };
}

/**
 * Share of the review's 6-word shingles found on the page, plus the first and
 * last paragraph that matched. Overlap is ~0 for unrelated pages; a real match
 * is 0.5+ (TR text is sometimes trimmed, so 1.0 is not required).
 */
function matchReview(fullText, paras) {
  const want = shingles(normWords(fullText));
  if (!want.size) return { overlap: 0, firstMatch: -1, lastMatch: -1 };
  const found = new Set();
  let firstMatch = -1;
  let lastMatch = -1;
  paras.forEach((p, k) => {
    const w = normWords(p);
    const total = Math.max(0, w.length - SHINGLE + 1);
    let hits = 0;
    for (let i = 0; i + SHINGLE <= w.length; i++) {
      const g = w.slice(i, i + SHINGLE).join(' ');
      if (want.has(g)) { found.add(g); hits++; }
    }
    // A paragraph only anchors the span when it is mostly the review's text.
    // One stock phrase ("one of the best of the") shared with the lead review
    // must not drag firstMatch up to paragraph 1 and its rating with it.
    if (hits >= 3 || (total && hits / total >= 0.5)) {
      if (firstMatch < 0) firstMatch = k;
      lastMatch = k;
    }
  });
  return { overlap: found.size / want.size, firstMatch, lastMatch };
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/** "Rating: Four out of five stars" / "Star rating: 3/5" / "FOUR STARS" / "Rating: ****" → 1..5, else null. */
function parseRatingLine(line) {
  const s = String(line || '').trim();
  if (s.length > 80) return null; // a heading line, never a body sentence
  let m = s.match(/\b([1-5])\s*\/\s*5\b/);
  if (m && /rating|star/i.test(s)) return Number(m[1]);
  m = s.match(/\b(one|two|three|four|five)\s+(?:stars?\s+)?out\s+of\s+(?:five|5)(?:\s+stars?)?\b/i);
  if (m) return WORD_NUM[m[1].toLowerCase()];
  m = s.match(/^(?:(?:star\s+)?rating\s*:?\s*)?(one|two|three|four|five)\s+stars?\.?$/i);
  if (m) return WORD_NUM[m[1].toLowerCase()];
  m = s.match(/^(?:(?:star\s+)?rating\s*:?\s*)?(\*{1,5}|★{1,5})\s*$/i);
  if (m) return m[1].length;
  return null;
}

/**
 * The matched section's own star rating: the nearest rating line in the few
 * heading paragraphs just above the first matched paragraph. Lines below the
 * section are never read (they head the NEXT review on bundled pages).
 */
function parseSectionRating(paras, firstMatch) {
  if (firstMatch < 0) return null;
  for (let k = firstMatch - 1; k >= Math.max(0, firstMatch - 4); k--) {
    const stars = parseRatingLine(paras[k]);
    if (stars) return { stars, line: paras[k] };
    // A body paragraph means we have walked back into the PREVIOUS review:
    // any rating above it is that review's, not this one's.
    if (String(paras[k] || '').length > 100) break;
  }
  // Some lead reviews open with the rating as the first body paragraph.
  const own = parseRatingLine(paras[firstMatch]);
  return own ? { stars: own, line: paras[firstMatch] } : null;
}

const TITLE_STOP = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'is', 'with', 'musical', 'play']);

/** Does the page title name the show (every distinctive title word present)? */
function titleNamesShow(pageTitle, showTitle) {
  const want = normWords(showTitle).map(w => w.replace(/'/g, '')).filter(w => w.length >= 3 && !TITLE_STOP.has(w));
  if (!want.length) return false;
  const have = new Set(normWords(pageTitle).map(w => w.replace(/'/g, '')));
  return want.every(w => have.has(w));
}

/**
 * lead = the page's main review, so the page-level extractor would read the
 * right stars. secondary = a bundled review further down the page. Lead needs
 * the page title to name the show, or the match to start at the top with no
 * other review's rating/verdict above it. Older /home/event/ pages head their
 * secondary reviews with "Title / Venue Until ..." and no rating text, so
 * depth alone (> 4 paragraphs in) also means secondary.
 */
function classifyPlacement(paras, firstMatch, pageTitle, showTitle) {
  // Title naming the show counts only near the top: bundle headlines can name
  // several shows, and one-word titles (Cats, Company) turn up by chance.
  if (firstMatch <= 6 && pageTitle && showTitle && titleNamesShow(pageTitle, showTitle)) return 'lead';
  if (firstMatch > 4) return 'secondary';
  for (let k = 0; k < Math.max(0, firstMatch - 2); k++) {
    if (parseRatingLine(paras[k]) || /^verdict\s*:/i.test(paras[k] || '')) return 'secondary';
  }
  return 'lead';
}

const MIN_OVERLAP = 0.5;

/**
 * Should the URL be written to the review file? Lead pages always (page-level
 * star extraction reads the right review). Secondary pages only when the
 * section's own rating was parsed, because it is written as originalScore and
 * that stops recollect-for-scores from reading the lead show's stars.
 */
function shouldWriteUrl(match) {
  if (!match || match.overlap < MIN_OVERLAP) return false;
  return match.placement === 'lead' || !!match.sectionRating;
}

/**
 * BRO-7869: DM article ids are handed out in sequence, so an id dates the
 * article. Each anchor is [day, median article id in that day's
 * /home/sitemaparchive/day_YYYYMMDD.html list] (measured 2026-11-20). The
 * median, not the max: day lists carry a few backdated articles with much
 * newer ids (the 2010-07-01 list holds a 2011 id). Pre-2012 lists are not
 * monotonic, so the table starts in 2012.
 */
const DM_ID_ANCHORS = [
  ['2012-01-01', 2080991], ['2012-07-01', 2167302], ['2013-01-01', 2255698], ['2013-07-01', 2352690],
  ['2014-01-01', 2532202], ['2014-07-01', 2676605], ['2015-01-01', 2893492], ['2015-07-01', 3145986],
  ['2016-01-01', 3381181], ['2016-07-01', 3670005], ['2017-01-01', 4079924], ['2017-07-01', 4657050],
  ['2018-01-01', 5226355], ['2018-07-01', 5906341], ['2019-01-01', 6544597], ['2019-07-01', 7201019],
  ['2020-01-01', 7842755], ['2020-07-01', 8479543], ['2021-01-01', 9104531], ['2021-07-01', 9745867],
  ['2022-01-01', 10360707], ['2022-07-01', 10973275], ['2023-01-01', 11590053], ['2023-07-01', 12254167],
  ['2024-01-01', 12916481], ['2024-07-01', 13588365], ['2025-01-01', 14241573], ['2025-07-01', 14864723],
  ['2026-01-01', 15427013], ['2026-07-01', 15944895],
];

// A review page created a full year before the review's own print date is not
// that review (BRO-7869: a Globe 2026 text carried the Drury Lane Dec 2024 url).
const URL_PREDATES_REVIEW_DAYS = 365;

/** DM article id of a dailymail.co.uk / dailymail.com url, else null. */
function dailyMailArticleId(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (!/(^|\.)dailymail\.(co\.uk|com)$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/article-(\d+)\//);
  return m ? Number(m[1]) : null;
}

/**
 * Proof that a DM url cannot be the review published on `publishDate`: the
 * url's article id is at or below an anchor's id, so the article existed by
 * that anchor day, and the review was published more than
 * URL_PREDATES_REVIEW_DAYS after it. Returns {articleId, anchorDate, gapDays}
 * or null (not DM, no id, no date, or no proof).
 */
function dailyMailUrlPredatesReview(url, publishDate, anchors = DM_ID_ANCHORS) {
  const id = dailyMailArticleId(url);
  const pub = Date.parse(String(publishDate || '').slice(0, 10));
  if (!id || Number.isNaN(pub)) return null;
  const anchor = anchors.find(([, anchorId]) => id <= anchorId);
  if (!anchor) return null;
  const gapDays = Math.floor((pub - Date.parse(anchor[0])) / 86400000);
  return gapDays > URL_PREDATES_REVIEW_DAYS ? { articleId: id, anchorDate: anchor[0], gapDays } : null;
}

module.exports = {
  DM_ID_ANCHORS,
  URL_PREDATES_REVIEW_DAYS,
  dailyMailArticleId,
  dailyMailUrlPredatesReview,
  normWords,
  shingles,
  parseDayArchive,
  isCandidatePath,
  extractArticle,
  matchReview,
  parseRatingLine,
  parseSectionRating,
  classifyPlacement,
  titleNamesShow,
  shouldWriteUrl,
  MIN_OVERLAP,
};
