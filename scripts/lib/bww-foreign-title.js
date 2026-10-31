/**
 * bww-foreign-title.js — detect a BWW Review Roundup entry that reviews a
 * DIFFERENT show whose title merely contains this show's title.
 *
 * BRO-4977: BroadwayWorld's roundup for the off-Broadway musical "Soon"
 * (2026-10-06) listed The Stage's review of "How Soon is Now?" (a UK touring
 * musical). The JSON-LD said so plainly — headline "The Stage - How Soon is
 * Now? review", url ".../reviews/how-soon-is-now-review" — but nothing read
 * the headline's title. The URL slug guard (cross-show-url.js) only knows
 * titles in shows.json, the entry was excerpt-only (paywall) so the content
 * verifier never ran, and the review went live on Soon scored 45.
 *
 * The rule is deliberately narrow, because a false positive drops a real
 * review:
 *   1. The headline (after "Outlet - ") must read "<X> review", so X is the
 *      title the outlet itself names. "Review: <X ...>" headlines are NOT
 *      judged: their X runs on into a sentence ("Review: Jodie Comer Makes
 *      'Prima Facie' Broadway's Most Powerful Show").
 *   2. X must contain this show's title as a contiguous word run AND carry
 *      extra words that are not decoration (Broadway, musical, revival, ...),
 *      a possessive credit ("Sondheim's Old Friends") or a venue / star
 *      qualifier after the title (", London Palladium", " at the Young Vic",
 *      " with Rachel Zegler"). X unrelated to the title says nothing.
 *   3. The posting's own URL must carry X's slug ("how-soon-is-now"), so the
 *      outlet's page agrees that X, not this show, is the subject.
 * Swept against every archived BWW roundup (4,048 postings): the only hits are
 * the Soon entry and roundups of School Girls / Bad Cinderella archived under
 * Mean Girls / Cinderella (see bww-foreign-title.test.mjs).
 * Pure, no I/O.
 */

'use strict';

const { foldDiacritics } = require('./title-match');

// Words a headline adds around a title without changing which show it is.
const DECORATION = new Set([
  'the', 'a', 'an', 'review', 'reviews', 'reviewed', 'theater', 'theatre',
  'broadway', 'off', 'offbroadway', 'west', 'end', 'london', 'new', 'york',
  'musical', 'play', 'revival', 'production', 'premiere', 'world', 'us',
  'uk', 'tour', 'touring', 'nyc', 'first', 'look', 'and', 'of',
  // "Harry Potter and the Cursed Child Parts One and Two"
  'part', 'parts', 'one', 'two', 'i', 'ii',
]);

function words(s) {
  return foldDiacritics(String(s || ''))
    .toLowerCase()
    .replace(/[‘’“”'"]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The title X of a "<X> review" headline, or null for any other shape.
 * @param {string} headline  BWW posting headline, "Outlet - Title" or bare title
 */
function headlineSubjectTitle(headline) {
  let h = String(headline || '').trim();
  const dash = h.indexOf(' - ');
  if (dash > 0) h = h.slice(dash + 3).trim();
  // Cut a trailing standfirst ("X review — when the end of life ...").
  const lead = h.split(/\s+[–—|]\s+|\s+-\s+/)[0].trim();
  if (/^(?:[\w-]+\s+)?review\s*[:–—-]/i.test(lead)) return null;
  const m = lead.match(/^(.+?)[\s:,?!.]*\breview\b[\s:.!?]*$/i);
  return m ? m[1].trim() : null;
}

/**
 * @param {{headline?: string, url?: string}} posting  BWW JSON-LD BlogPosting
 * @param {string} showTitle  this show's title (shows.json)
 * @returns {null | {subjectTitle: string, extraWords: string[]}}
 */
function detectForeignTitlePosting(posting, showTitle) {
  if (!posting || !showTitle) return null;
  const subject = headlineSubjectTitle(posting.headline);
  if (!subject) return null;
  const q = foldDiacritics(subject).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

  // Title variants: full, without parenthetical, without subtitle, without "The".
  const variants = new Set();
  const base = String(showTitle).replace(/\s*\([^)]*\)/g, '');
  for (const t of [showTitle, base, base.split(/:\s/)[0]]) {
    const w = words(t);
    if (w.length) variants.add(w.join(' '));
    if (w[0] === 'the' && w.length > 1) variants.add(w.slice(1).join(' '));
  }

  for (const v of variants) {
    // Locate the title in the ORIGINAL subject text so punctuation around it
    // (possessives, commas) is still visible.
    // Title words were built with apostrophes removed ("Hell's" -> "hells"), so
    // allow an apostrophe anywhere inside a word when matching.
    const wordRe = (w) => w.split('').join("'?");
    const re = new RegExp('(^|[^a-z0-9])' + v.split(' ').map(wordRe).join('[^a-z0-9]+') + '(?=[^a-z0-9]|$)', 'i');
    const hit = re.exec(q);
    if (!hit) continue;
    // "Stephen Sondheim's Old Friends": a possessive credit, not the title.
    const before = q.slice(0, hit.index + hit[1].length).replace(/^.*'s\s+/i, '');
    // After the title, a comma or a venue/star qualifier ends the title.
    const after = q.slice(hit.index + hit[0].length).split(/,|\(|\s(?:at|with|in|on|starring|featuring|by)\s/i)[0];
    const extra = [...words(before), ...words(after)]
      .filter(w => !DECORATION.has(w) && !/^(?:19|20)\d\d$/.test(w));
    if (extra.length === 0) return null; // same show, decorated
    // The outlet's page must agree: its url carries the whole subject slug.
    let urlPath = '';
    try { urlPath = new URL(posting.url).pathname.toLowerCase(); } catch { return null; }
    const subjectSlug = words(subject).join('-');
    if (!urlPath.includes(subjectSlug)) return null;
    return { subjectTitle: subject, extraWords: extra };
  }
  return null;
}

/**
 * Every foreign-title posting in a BWW roundup page's JSON-LD. For the parsers
 * that do not walk the postings themselves (scrape-bww-reviews.js reads the
 * article HTML, the LLM fallback reads the page text): they drop any review
 * whose url or excerpt matches one of these.
 * @returns {Array<{url: string|null, subjectTitle: string, excerpt: string}>}
 */
function foreignTitleEntriesFromHtml(html, showTitle) {
  const out = [];
  if (!html || !showTitle) return out;
  for (const m of String(html).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const raw = m[1].replace(/[\x00-\x1F\x7F]/g, ' ');
    let json;
    try { json = JSON.parse(raw); } catch {
      try { json = JSON.parse(require('./aggregator-candidate-extract').sanitizeBwwJsonLd(raw)); } catch { continue; }
    }
    const items = Array.isArray(json) ? json : [json];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const postings = item['@type'] === 'BlogPosting' ? [item]
        : (item['@type'] === 'LiveBlogPosting' && Array.isArray(item.liveBlogUpdate) ? item.liveBlogUpdate : []);
      for (const p of postings) {
        const hit = detectForeignTitlePosting(p, showTitle);
        if (hit) out.push({ url: p.url || null, subjectTitle: hit.subjectTitle, excerpt: String(p.articleBody || p.description || '') });
      }
    }
  }
  return out;
}

function urlKey(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return null; }
}
const textKey = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 80);

/** True when a parsed review is one of the foreign-title entries (same url, or same excerpt opening). */
function isForeignTitleReview(review, entries) {
  if (!review || !entries || entries.length === 0) return false;
  const u = review.url ? urlKey(review.url) : null;
  const ex = textKey(review.bwwExcerpt || review.excerpt || review.quote || '');
  return entries.some(e => {
    if (u && e.url && urlKey(e.url) === u) return true;
    const ek = textKey(e.excerpt);
    return ex.length >= 40 && ek.length >= 40 && (ek.startsWith(ex) || ex.startsWith(ek));
  });
}

module.exports = { detectForeignTitlePosting, headlineSubjectTitle, foreignTitleEntriesFromHtml, isForeignTitleReview };
