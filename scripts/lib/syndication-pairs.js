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

/**
 * Publishing groups (BRO-2406): outlets under common ownership that reprint a
 * staff critic's review. Order = primacy (first = original publisher). Applies
 * to ANY critic with a real byline, not only critics hand-listed in
 * KNOWN_SYNDICATION_PAIRS — the third Chris Jones/Chicago Tribune recurrence
 * was a sibling of the same class (Tribune-group reprint) the per-critic map
 * could not anticipate.
 */
const PUBLISHING_GROUPS = [
  ['chicagotribune', 'nydailynews', 'baltimoresun', 'hartford-courant', 'orlando-sentinel', 'south-florida-sun-sentinel'],
];

function _isRealByline(criticName) {
  const c = String(criticName || '').toLowerCase().trim();
  return !!c && !/^(unknown|staff|n\/a|none|anonymous)$/.test(c);
}

/**
 * Outlet ids that, for this critic, are the primary publisher of a review that
 * `outletId` would merely be reprinting. Empty array = outletId is not a
 * syndicated secondary. Union of the per-critic map and publishing groups.
 */
function getSyndicationPrimaries(criticName, outletId) {
  if (!_isRealByline(criticName) || !outletId) return [];
  const out = new Set();
  const cfg = getSyndicationConfig(criticName);
  if (cfg && cfg.secondary.includes(outletId)) out.add(cfg.primary);
  for (const group of PUBLISHING_GROUPS) {
    const i = group.indexOf(outletId);
    if (i > 0) group.slice(0, i).forEach(o => out.add(o));
  }
  return [...out];
}

/**
 * True when two review records are the same critic's article published at two
 * different outlets under a known syndication relationship (per-critic pair,
 * shared publishing group) or explicitly declared so by a human
 * (duplicateReason /syndicat/). Their URLs differ BY DEFINITION, so a
 * duplicateOf pointer between them must never be judged stale on URL mismatch.
 * @param {{criticName?:string,outletId?:string,duplicateReason?:string}} a record holding the pointer
 * @param {{criticName?:string,outletId?:string}} b pointer target
 * @param {(o:string)=>string} [normalize] outlet normalizer
 */
function isCrossOutletSyndicationPair(a, b, normalize = (o) => o) {
  if (!a || !b) return false;
  const oa = normalize(a.outletId || a.outlet || '');
  const ob = normalize(b.outletId || b.outlet || '');
  if (!oa || !ob || oa === ob) return false;
  if (/syndicat|reprint|repost/i.test(String(a.duplicateReason || ''))) return true;
  const ca = String(a.criticName || '').toLowerCase().trim();
  const cb = String(b.criticName || '').toLowerCase().trim();
  if (!_isRealByline(ca) || ca !== cb) return false;
  return getSyndicationPrimaries(ca, oa).includes(ob) || getSyndicationPrimaries(ca, ob).includes(oa);
}

module.exports = {
  KNOWN_SYNDICATION_PAIRS, PUBLISHING_GROUPS, getSyndicationConfig, isSecondaryOutlet,
  getSyndicationPrimaries, isCrossOutletSyndicationPair,
};
