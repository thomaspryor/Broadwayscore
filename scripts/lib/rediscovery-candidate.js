'use strict';

/**
 * rediscovery-candidate.js — does a review file already hold real article text,
 * or should rediscover-review-urls.js look for a live URL for it?
 *
 * The old inline rule skipped any file with fullText > 100 chars. Aggregator
 * pull-quotes (Show Score / DTLI / BWW excerpts, 100-600 chars) are stored in
 * fullText too, so a review whose URL died was never rediscovered once it had
 * an excerpt: 84 files on 2026-09-30, e.g. amelie-a-new-musical-2017/
 * timeout--adam-feldman.json (118-char excerpt, Time Out moved the page).
 *
 * A short text only counts as "has text" when the URL itself is not the known
 * failure. Long texts are left alone even on a URL failure: rediscovery resets
 * the file for re-scrape, and a long text flagged url_content_mismatch can be a
 * canonical-tag false positive holding the real article.
 */

// incompleteReason values that say the stored URL does not serve this review.
const URL_FAILURE_REASONS = new Set(['url_dead', 'url_content_mismatch']);

// Longest text we treat as an excerpt rather than article text.
const EXCERPT_MAX_CHARS = 600;

function hasUsableText(data) {
  const len = typeof data?.fullText === 'string' ? data.fullText.length : 0;
  if (len <= 100) return false;
  if (URL_FAILURE_REASONS.has(data.incompleteReason) && len < EXCERPT_MAX_CHARS) return false;
  return true;
}

// Words too common in review URL paths to show two slugs are the same article.
const SLUG_STOPWORDS = new Set([
  'the', 'and', 'of', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'is', 'review', 'reviews',
  'theater', 'theatre', 'broadway', 'legit', 'article', 'news', 'arts', 'culture', 'stage',
  'www', 'com', 'html', 'htm', 'php', 'entertainment',
]);

// Opaque ids (ny-20221202-varbwx6ldnapvoyrn57ns2ruwi-story) contain digits;
// only digit-free tokens are words that can show two slugs name one article.
function slugTokens(s) {
  let text = s;
  try { text = decodeURIComponent(s); } catch { /* keep raw */ }
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !/\d/.test(t) && !SLUG_STOPWORDS.has(t)),
  );
}

// Aggregator data describes the review itself, not whatever page its URL
// served, so it survives a URL move made by rediscovery or its repair.
const { EXCERPT_FIELDS } = require('./excerpt-fields');
const AGGREGATOR_FIELDS = [
  ...EXCERPT_FIELDS,
  'aggregatorStars', 'aggregatorStarsSource',
  'originalScore', 'originalScoreSource', 'originalScoreNormalized', 'originalScoreType', 'originalRating',
  'bwwScore', 'dtliScore', 'dtliThumb', 'showScoreScore', 'bwwRoundupScore',
];

// Admin/login/queue pages are scraper junk, not review URLs to restore.
const JUNK_URL_RE = /\/wp-(login|admin)|queue-it\.net|\/login\b/i;

/**
 * Is a redirect target plausibly the same article? Redirects are followed
 * blindly otherwise, and publishers redirect dead reviews to homepages or to
 * unrelated pages: variety.com/2007/legit/reviews/cyrano-de-bergerac-1200558847/
 * 301s to a Luisa Fernanda photo attachment (seen 2026-09-30).
 * Refuses: a target with no path (homepage/section root) when the source had
 * one, WordPress attachment pages, and a target whose path shares no
 * distinctive word with the source's (only when the source has 2+ such words,
 * so opaque ids like /article/SB1000... still follow).
 * @returns {{ ok: boolean, reason?: string }}
 */
function isPlausibleArticleRedirect(fromUrl, toUrl) {
  let from; let to;
  try { from = new URL(fromUrl); to = new URL(toUrl, fromUrl); } catch { return { ok: false, reason: 'unparseable' }; }
  const fromPath = from.pathname.replace(/\/+$/, '');
  const toPath = to.pathname.replace(/\/+$/, '');
  if (fromPath && !toPath) return { ok: false, reason: 'redirects to site root' };
  if (/\/attachment\//i.test(toPath) && !/\/attachment\//i.test(fromPath)) return { ok: false, reason: 'redirects to an attachment page' };
  const fromTok = slugTokens(fromPath + ' ' + from.search);
  if (fromTok.size >= 2) {
    const toTok = slugTokens(toPath + ' ' + to.search);
    const shared = [...fromTok].some((t) => toTok.has(t));
    if (!shared) return { ok: false, reason: 'redirect target shares no slug word with the review URL' };
  }
  return { ok: true };
}

function foldTitle(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’‘`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Past http-redirect rewrite that repair-implausible-redirects.js should undo:
 * the redirect fails isPlausibleArticleRedirect AND the text on disk does not
 * name the show (a correct move to an opaque new slug keeps its text, e.g.
 * nydailynews ny-20221202-...-story.html -> /2022/12/02/in-aint-no-mo-...).
 * @param {object} data review file
 * @param {string} showTitle shows.json title
 * @returns {{ repair: boolean, from?: string, reason?: string }}
 */
function redirectRepairDecision(data, showTitle) {
  if (!data || data.urlDiscoveryMethod !== 'http-redirect') return { repair: false };
  const from = data.previousUrl || (data._urlChangedClear && data._urlChangedClear.from);
  if (!from || !data.url) return { repair: false };
  if (JUNK_URL_RE.test(from) || JUNK_URL_RE.test(data.url)) return { repair: false, reason: 'admin/login/queue URL (junk record, not a review)' };
  const verdict = isPlausibleArticleRedirect(from, data.url);
  if (verdict.ok) return { repair: false };
  // A section front (amny.com/entertainment/) lists many shows, so naming the
  // show proves nothing there.
  let sectionFront = false;
  try { sectionFront = /^\/[a-z]+\/?$/i.test(new URL(data.url).pathname); } catch { /* unparseable: not a section */ }
  const title = foldTitle(showTitle);
  if (!sectionFront && title && foldTitle(data.fullText).includes(title)) return { repair: false, reason: 'text names the show' };
  return { repair: true, from, reason: verdict.reason };
}

module.exports = {
  hasUsableText, isPlausibleArticleRedirect, redirectRepairDecision, foldTitle,
  URL_FAILURE_REASONS, EXCERPT_MAX_CHARS, AGGREGATOR_FIELDS,
};
