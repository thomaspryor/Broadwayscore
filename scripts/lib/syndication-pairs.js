/**
 * Known syndication pairs — shared across rebuild + gather-reviews.
 *
 * Same critic publishes at a primary outlet + one or more secondary outlets
 * simultaneously (wire service, content-sharing agreement). Secondary copies
 * are skipped at rebuild time even without an isSyndicatedDuplicate flag on file,
 * and gather-reviews uses this map to avoid creating duplicate files.
 *
 * Keys are lowercase critic names. Values are { primary, secondary[] } where
 * each entry is the outletId used in the review-texts filenames.
 *
 * Extracted per CLAUDE.md §15 so tests can require() the real data without
 * copying it. Added via Pattern Card #6.
 */
const KNOWN_SYNDICATION_PAIRS = {
  'chris jones': { primary: 'chicagotribune', secondary: ['nydailynews'] },
  'kathleen campion': { primary: 'nytg', secondary: ['front-row-center'] },
  'tulis mccall': { primary: 'nytg', secondary: ['front-row-center'] },
  'stanford friedman': { primary: 'nytg', secondary: ['front-row-center'] },
  'david rooney': { primary: 'hollywood-reporter', secondary: ['reuters'] },
  'alexandra lipari': { primary: 'newsday', secondary: ['entertainmenthour'] },
  'zachary stewart': { primary: 'theatermania', secondary: ['whatsonstage'] },
  'david gordon': { primary: 'theatermania', secondary: ['whatsonstage'] },
  'mark kennedy': { primary: 'ap', secondary: ['abc-news', 'collider', 'washington-times', 'minneapolis-star-tribune'] },
  'jennifer farrar': { primary: 'ap', secondary: ['abc-news', 'minneapolis-star-tribune'] },
};

/**
 * Returns the syndication config for a critic, or null if not a known syndicated critic.
 * @param {string} criticName - Lowercased critic name
 */
function getSyndicationConfig(criticName) {
  if (!criticName) return null;
  return KNOWN_SYNDICATION_PAIRS[criticName.toLowerCase().trim()] || null;
}

/**
 * Returns true if outletId is a secondary (syndicated copy) outlet for this critic.
 * @param {string} criticName
 * @param {string} outletId
 */
function isSecondaryOutlet(criticName, outletId) {
  const config = getSyndicationConfig(criticName);
  if (!config) return false;
  return config.secondary.includes(outletId);
}

module.exports = { KNOWN_SYNDICATION_PAIRS, getSyndicationConfig, isSecondaryOutlet };
