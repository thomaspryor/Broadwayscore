/**
 * Single source of truth for all excerpt field names.
 *
 * IMPORTANT: When adding a new excerpt type (e.g. from a new aggregator),
 * add it here and ALL scripts will pick it up automatically.
 * Run: grep -rn "excerptFields\|hasExcerpt\|EXCERPT_FIELDS" scripts/
 * to find any hardcoded lists that need updating.
 */

const { isLegacyWebSearchOnly } = require('./legacy-web-search');
const { foldDiacritics } = require('./url-slug');

const EXCERPT_FIELDS = [
  'dtliExcerpt',
  'bwwExcerpt',
  'showScoreExcerpt',
  'nycTheatreExcerpt',
  'lboRoundupExcerpt',
  'westEndTheatreExcerpt',
  'theatreReviewsExcerpt',
  'theStageExcerpt',
  'stagedoorExcerpt',
  'playbillVerdictExcerpt',
  // BRO-5794: headline + standfirst from the review page's own metadata, for a
  // real review whose full text can't be fetched (lib/page-meta-evidence.js).
  // Last in the list so verifierExcerpt() prefers every aggregator excerpt.
  'metaExcerpt',
];

/**
 * Check if a review data object has any excerpt.
 * @param {object} data - Review data object
 * @returns {boolean}
 */
function hasExcerpt(data) {
  return EXCERPT_FIELDS.some(f => !!data[f]);
}

/**
 * Get all non-empty excerpts from a review data object.
 * @param {object} data - Review data object
 * @returns {string[]}
 */
function getExcerpts(data) {
  return EXCERPT_FIELDS.map(f => data[f]).filter(Boolean);
}

/**
 * Get the longest excerpt from a review data object.
 * @param {object} data - Review data object
 * @returns {string}
 */
function getLongestExcerpt(data) {
  return EXCERPT_FIELDS.reduce((best, f) => {
    const val = data[f] || '';
    return val.length > best.length ? val : best;
  }, '');
}

/**
 * The excerpt handed to the content verifier (verifyContent) as the reference
 * the scraped page should match. A legacy web-search row's excerpt was made up
 * by that step (BRO-5183), so comparing the real page against it can only
 * mislead the verifier: it gets none.
 * @param {object} data - Review data object
 * @param {{skipNonQuotes?: boolean}} [opts] skipNonQuotes (BRO-5344): drop an excerpt that is not
 *   a quote of the row's own complete fullText. Opt-in, and no caller uses it yet: the reverify
 *   scripts pass the stored fullText as the scraped text, so for them a mismatch is the
 *   wrong-show signal, not noise.
 * @returns {string}
 */
function verifierExcerpt(data, opts = {}) {
  if (!data || isLegacyWebSearchOnly(data)) return '';
  const excerpts = EXCERPT_FIELDS.map((f) => data[f]).filter(Boolean);
  if (!opts.skipNonQuotes) return excerpts[0] || '';
  const text = quoteHaystack(data);
  return excerpts.find((e) => isQuoteOfFullText(e, data, text)) || '';
}

const LEADING_WORDS = 8;
const MIN_FULLTEXT_CHARS = 300;
const MIN_FRAGMENT_WORDS = 5;

function normalizeWords(text) {
  return foldDiacritics(String(text || ''))
    .toLowerCase()
    .replace(/&(?:rsquo|lsquo|apos|#39|#8217|#8216|#x27|#x2019);/g, "'")
    .replace(/&amp;|&(?![#\w]+;)/g, ' and ')
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/(^|[^a-z0-9])'|'(?![a-z0-9])/g, '$1 ')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

function quoteHaystack(data) {
  return ' ' + normalizeWords(data && data.fullText) + ' ';
}

/**
 * BRO-5344: an aggregator excerpt that is not a quote of the row's own
 * complete stored text (a paraphrase, or text from another production or
 * edition) must not anchor the content verifier or excerpt-only scoring.
 * Only judged against a complete fullText; otherwise there is nothing to
 * compare with and the excerpt counts as a quote. An excerpt may stitch
 * several quoted fragments together with an ellipsis, so it is a quote when
 * the leading words of any fragment occur in the text.
 * @param {string} excerpt
 * @param {object} data - Review data object
 * @returns {boolean} false when no fragment's leading words occur in fullText
 */
function isQuoteOfFullText(excerpt, data, haystackIn) {
  if (!data || data.contentTier !== 'complete') return true;
  if (typeof data.fullText !== 'string' || data.fullText.length < MIN_FULLTEXT_CHARS) return true;
  const haystack = haystackIn || quoteHaystack(data);
  const fragments = String(excerpt || '').split(/\.{2,}|(?:\.\s){2,}\.|\u2026/).map((f) => normalizeWords(f).split(' ').filter(Boolean));
  const usable = fragments.filter((w) => w.length >= MIN_FRAGMENT_WORDS);
  if (!usable.length) return true;
  return usable.some((w) => haystack.includes(' ' + w.slice(0, LEADING_WORDS).join(' ') + ' '));
}

module.exports = { EXCERPT_FIELDS, hasExcerpt, getExcerpts, getLongestExcerpt, verifierExcerpt, isQuoteOfFullText };
