/**
 * BRO-6078: a canonical review with no rating of its own, whose same-URL twin (a rename-collided byline, a
 * duplicateOf loser) carries the critic's star/grade, published a score outside that rating's band because the
 * band clamp (rebuild-helpers getBestScore) only sees the canonical's own fields. The clamp now also reads the
 * twin's rating. Used for the clamp ONLY: the canonical's source and precedence are unchanged.
 *
 * Pure: callers pass a loader and the URL canonicalizer so this is unit-testable without the filesystem.
 */
const has = (v) => v !== null && v !== undefined && v !== '';

function ownRatingField(d) {
  if (has(d.starRating)) return d.starRating;
  if (has(d.originalRating)) return d.originalRating;
  if (typeof d.originalScore === 'string' && has(d.originalScore)) return d.originalScore;
  return null;
}

/**
 * @param {string} file basename of the canonical review-text file
 * @param {object} data parsed canonical
 * @param {string[]} siblingFiles basenames in the same show dir
 * @param {(name: string) => object|null} load parsed sibling loader
 * @param {(url: string) => string} canonicalUrl
 * @param {(d: object) => ({highReliability?: boolean, band?: {floor: number, ceiling: number}}|null)} detectBand
 * @returns {{file: string, data: object}|null} the twin record whose rating to clamp against (its full evidence), or null (own rating present / no usable twin / twins disagree)
 */
const { foldDiacritics } = require('./title-match');
const norm = (n) => foldDiacritics(String(n || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
const unknownCritic = (n) => !norm(n) || norm(n) === 'unknown';

/** Twin = a duplicateOf link either way, or the same critic (typo-fuzzy), or a byline missing on either side. A bare URL match is not enough: multi-critic pages share one URL. */
function isTwin(file, data, name, d, sameCriticFuzzy) {
  if (d.duplicateOf === file || data.duplicateOf === name) return true;
  if (unknownCritic(data.criticName) || unknownCritic(d.criticName)) return true;
  return norm(data.criticName) === norm(d.criticName) || !!(sameCriticFuzzy && sameCriticFuzzy(data.criticName, d.criticName));
}

/** The twin's record without aggregator relays: only the outlet's own rating may bind (relays must not). */
function ownRatingOnly(d) {
  const { aggregatorStars, wetStars, ...rest } = d;
  return rest;
}

function siblingRatingForClamp(file, data, siblingFiles, load, canonicalUrl, detectBand, sameCriticFuzzy) {
  if (!data || !data.url || ownRatingField(data) !== null || typeof data.originalScore === 'number') return null;
  if (/tickets?-and-information|\/tickets\b/i.test(data.url) || data.originalScoreCleared) return null;
  const url = canonicalUrl(data.url);
  const found = new Map(); // "floor-ceiling" -> {file, data}
  for (const name of siblingFiles) {
    if (name === file) continue;
    const d = load(name);
    if (!d || !d.url || canonicalUrl(d.url) !== url) continue;
    if (d.wrongShow || d.wrongProduction || d.isRoundupArticle || d.originalScoreCleared) continue;
    if (!isTwin(file, data, name, d, sameCriticFuzzy)) continue;
    const rating = ownRatingField(d);
    if (rating === null || /%/.test(String(rating))) continue; // a percentage is not a star/grade band
    const det = detectBand(ownRatingOnly(d)); // the donor's own record: outlet/text corroboration decide reliability
    if (!det || !det.band || !det.highReliability) continue;
    if (!found.has(`${det.band.floor}-${det.band.ceiling}`)) found.set(`${det.band.floor}-${det.band.ceiling}`, { file: name, data: ownRatingOnly(d) });
  }
  // Twins that disagree on the band: no safe call, leave the score alone.
  if (found.size !== 1) return null;
  return [...found.values()][0];
}

module.exports = { siblingRatingForClamp };
