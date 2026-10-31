/**
 * BRO-5785: an ensemble `wrong_show` verdict that only ever saw an aggregator
 * EXCERPT is a verdict on the excerpt, not on the review. Aggregators mis-pair
 * excerpts (New York Theatre Guide's "Two Girls" review carried School Girls
 * text), and writing wrongShow=true + rejected* on that evidence excludes a
 * correct review. When there is no fullText to confirm it and the review URL
 * slug names the show, hold the flag and queue a text fetch instead.
 *
 * The URL is used only to SUPPRESS a destructive write, never to derive
 * metadata (CLAUDE.md §3).
 */
const { foldDiacritics } = require('./url-slug');

const MIN_FULLTEXT = 100; // same floor as selectScorableText (scorable-text.js)

function normalize(s) {
  return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * True when the LAST path segment of the URL opens with the show title (word
 * boundary, optional leading "the"), e.g. two-girls-off-broadway-review for
 * "Two Girls". Anchoring to the segment start avoids matching a title that
 * merely appears inside another show's or outlet's slug (a "Company" gala, a
 * "Girls" fragment of "school-girls"). Misses are the safe direction: the
 * verdict then stands, as before.
 */
function urlSlugNamesShow(url, showTitle) {
  if (!url || !showTitle) return false;
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url); }
  const segment = normalize(path.split('/').filter(Boolean).pop() || '');
  const title = normalize(String(showTitle).replace(/&/g, ' and ')).replace(/^the /, '');
  if (title.length < 5 && title.split(' ').length < 2) return false;
  const seg = segment.replace(/^the /, '');
  return seg === title || seg.startsWith(`${title} `);
}

/**
 * @param {Object} args
 * @param {string} args.rejection - ensemble rejection type
 * @param {string|null} args.scoredTextType - getBestTextForScoring().type
 * @param {Object} args.fileData - review file (fullText, url)
 * @param {string} [args.showTitle]
 * @returns {{suppress: boolean, reason: string|null}}
 */
function shouldSuppressExcerptOnlyWrongShow({ rejection, scoredTextType, fileData, showTitle }) {
  if (rejection !== 'wrong_show') return { suppress: false, reason: null };
  if (scoredTextType !== 'excerpt') return { suppress: false, reason: null };
  const hasFullText = typeof fileData?.fullText === 'string' && fileData.fullText.length >= MIN_FULLTEXT;
  if (hasFullText) return { suppress: false, reason: null };
  if (!urlSlugNamesShow(fileData?.url, showTitle)) return { suppress: false, reason: null };
  return { suppress: true, reason: 'excerpt_only_wrong_show_url_names_show' };
}

module.exports = { shouldSuppressExcerptOnlyWrongShow, urlSlugNamesShow };
