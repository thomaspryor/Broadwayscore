'use strict';

/**
 * Wrong-article screen (BRO-4383).
 *
 * A review file can hold the text of a DIFFERENT article: recovery writers
 * (wayback, WSJ subscriber/browser, SERP) derive the "show title" from the
 * slug and validateShowMentioned accepts coincidental id-word pairs
 * ("little" + "road") or a common-noun title ("pied-à-terre"). Two scored
 * wrong articles reached the live site that way (little-bear-ridge-road NYTheater
 * = a Jen Tullock play; pied-a-terre WSJ = a 2021 review of "The Visitor").
 *
 * A text is SUSPECT when it carries no identity evidence for the show:
 *   - no cast / creative-team / venue keyword (title words excluded — they are
 *     exactly what coincidental matches hit), AND
 *   - the title is named at most once (0 = never; 1 = could be a common noun).
 * Cheap and pure: the screen only narrows candidates. Callers decide (LLM
 * verification in the audit; quarantine at the write chokepoint).
 */

const { buildShowTitleVariants, normalizeForMention, countVariant } = require('./show-title-variants');
const { buildShowKeywordSet, findShowKeywordInText } = require('./review-guards');

const MIN_TEXT_CHARS = 1500;

function countTitleMentions(text, show) {
  const norm = normalizeForMention(text);
  const titles = [show.title, ...(show.alternateTitles || []), ...(show.aliases || [])].filter(Boolean);
  let best = 0;
  for (const t of titles) {
    // Longest variant counts; shorter prefixes of the same title must not double count.
    const total = buildShowTitleVariants(t).reduce((m, v) => (v.length >= 3 ? Math.max(m, countVariant(norm, v)) : m), 0);
    best = Math.max(best, total);
  }
  return best;
}

/**
 * @param {string} text
 * @param {Object} show - shows.json entry
 * @returns {{ applicable: boolean, sparseIdentity?: boolean, suspect: boolean, titleMentions: number, identityKeyword: string|null }}
 */
function screenWrongArticle(text, show) {
  if (!show || typeof text !== 'string' || text.length < MIN_TEXT_CHARS) {
    return { applicable: false, suspect: false, titleMentions: 0, identityKeyword: null };
  }
  const titleMentions = countTitleMentions(text, show);
  const keywords = buildShowKeywordSet({ ...show, title: '' });
  const identityKeyword = findShowKeywordInText(text, keywords);
  // Sparse metadata leaves nothing to corroborate a non-literal title mention,
  // so the screen fails open rather than guess. Venue words alone do not count
  // (BRO-5142): historical WE rows (promote-historical-we.js) carry a venue but
  // no cast/creativeTeam, and a real review often never names the house, so
  // "Harold Pinter" absent from an Anna X review was flagged wrongShow.
  const castCreativeKeywords = buildShowKeywordSet({ cast: show.cast, creativeTeam: show.creativeTeam });
  const sparseIdentity = castCreativeKeywords.size < 2;
  // identityKeyword still searches cast + creative + venue (a venue hit clears suspicion).
  return { applicable: true, sparseIdentity, suspect: !identityKeyword && titleMentions <= 1, titleMentions, identityKeyword };
}

module.exports = { screenWrongArticle, countTitleMentions, MIN_TEXT_CHARS };
