'use strict';

/**
 * page-market-qualifier.js (BRO-2551)
 *
 * Reads the explicit market qualifier an aggregator page carries in its
 * <title> / canonical URL, and decides whether that qualifier contradicts the
 * category of the show the page was filed under ("cross-market-sibling" in
 * validateRoundupPageTitle / checkTitleMatchSiblingGuards).
 *
 * Pure: no fs, no shows.json. show-matching.js re-exports
 * detectPageMarketQualifier() from here so every existing caller keeps the
 * same category answer.
 *
 * WHY THE RULE IS A TABLE OF PAIRS, NOT "qualifier !== category"
 * Measured against the full cached corpus (data/aggregator-archive, 7,248
 * show-keyed pages, 2026-11-19). Every page whose qualifier disagreed with its
 * show's category was read by hand (page venue / review dates vs the show's
 * own production):
 *
 *   - "Off-Broadway" (BWW "X Off-Broadway Reviews", DTLI "(Off-Broadway)"):
 *     51 disagreeing pages on broadway / west-end / off-west-end / tour
 *     shows, ALL a different (NYC) production: BWW's
 *     /reviews/<Title> page lists whichever production BWW last tracked under
 *     that title (a-streetcar-named-desire-2012 held the 2025 BAM revival,
 *     the-imaginary-invalid-2026 held the 2025 New World Stages run,
 *     hercules-west-end-2025 held the 2019 Delacorte run). 0 legitimate.
 *   - "Broadway", by title-level wording ("(Broadway)", "on Broadway") or
 *     Show Score's /broadway-shows/ canonical: on west-end / off-west-end /
 *     tour shows, 34 pages, all NYC productions (Show Score "Cabaret
 *     (Broadway) NYC Reviews" under cabaret-west-end-2012, BWW "Review
 *     Roundup: PUNCH Opens on Broadway" under punch-west-end-2025). 0 legit.
 *     On off-broadway shows only the TITLE-level wording is clean (8 pages,
 *     all the Broadway transfer: "Dear Evan Hansen (Broadway)" under
 *     dear-evan-hansen-off-broadway-2016); Show Score's /broadway-shows/ URL
 *     bucket alone does not separate Broadway from Off-Broadway (the
 *     2026-08-16 the-gin-game-2026 false positive), so it does not count there.
 *   - "Broadway Reviews" alone (BWW /reviews/ and Playbill "Read the Broadway
 *     Reviews for X") is page-type boilerplate used for every market (BWW
 *     titles West End and Off-Broadway listings this way too) — never trusted
 *     outside the original regional+sibling rule.
 *   - "(West End)" on off-west-end shows: Show Score labels every London show
 *     "(West End)" — the market is right, the category split is ours. Not a
 *     conflict.
 *   - Regional keeps its original rule exactly (any qualifier, but only when
 *     a same-title sibling in that market exists), which tests pin.
 * Net effect on the corpus: 93 newly flagged pages, all wrong productions;
 * 0 previously accepted legitimate pages flagged.
 * Pairs with no measured poisoned example (e.g. a "(West End)" page on a
 * Broadway show: 0 occurrences) are deliberately NOT added.
 */

// Order matters: off-broadway/off-west-end before broadway/west-end, since
// "(Off-Broadway)" also contains "Broadway)".
const PAGE_MARKET_QUALIFIERS = [
  { category: 'off-broadway', re: /\(off[\s-]?broadway\)|\boff-broadway reviews\b|\/off-broadway-shows\//i },
  { category: 'broadway', re: /\(broadway\)|\bon broadway\b|\bbroadway reviews\b|\/broadway-shows\//i },
  { category: 'off-west-end', re: /\(off[\s-]?west end\)/i },
  { category: 'west-end', re: /\(west end\)/i },
];

// Broadway wording that names the market of THIS page rather than the page type.
const BROADWAY_TITLE_EXPLICIT = /\(broadway\)|\bon broadway\b/i;
const BROADWAY_CANONICAL_PATH = /\/broadway-shows\//i;

// Only the TheaterEvent's own location is evidence; review text and other
// structured data can mention unrelated Broadway venues.
function hasBroadwayEventLocation(html) {
  const scripts = String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes.flatMap(n => n && Array.isArray(n['@graph']) ? n['@graph'] : [n])) {
      if (!node || !(Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes('TheaterEvent')) continue;
      if (typeof node.location?.name === 'string' && /\(Broadway\)/i.test(node.location.name)) return true;
    }
  }
  return false;
}

function canonicalHref(html) {
  const m = String(html || '').match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  return m ? (m[0].match(/href=["']([^"']+)["']/i) || [])[1] || '' : '';
}

/**
 * @param {string} html
 * @param {string} pageTitle
 * @returns {null|{category:string, strength:'explicit'|'canonical-path'|'jsonld-location'|'boilerplate'}}
 *   category: same answer detectPageMarketQualifier() has always given.
 *   strength (only meaningful for 'broadway'; other categories are always
 *   'explicit'): 'explicit' = title says "(Broadway)"/"on Broadway";
 *   'canonical-path' = only a /broadway-shows/ canonical URL;
 *   'jsonld-location' = BWW TheaterEvent location names a Broadway venue;
 *   'boilerplate' = only "Broadway Reviews" page-type wording.
 */
function detectPageMarketSignal(html, pageTitle) {
  const title = pageTitle || '';
  const href = canonicalHref(html);
  const haystack = `${title} ${href}`.toLowerCase();
  const hit = PAGE_MARKET_QUALIFIERS.find(q => q.re.test(haystack));
  if (!hit) return null;
  if (hit.category !== 'broadway') return { category: hit.category, strength: 'explicit' };
  if (BROADWAY_TITLE_EXPLICIT.test(title)) return { category: 'broadway', strength: 'explicit' };
  if (BROADWAY_CANONICAL_PATH.test(href)) return { category: 'broadway', strength: 'canonical-path' };
  if (/\bBroadway\s*World\b/i.test(title) && hasBroadwayEventLocation(html)) return { category: 'broadway', strength: 'jsonld-location' };
  return { category: 'broadway', strength: 'boilerplate' };
}

/** Category only — the long-standing show-matching.js API. */
function detectPageMarketQualifier(html, pageTitle) {
  const s = detectPageMarketSignal(html, pageTitle);
  return s ? s.category : null;
}

// Measured-clean (show category -> qualifier) pairs that need no sibling.
// Each value is the set of broadway-signal strengths trusted for that pair
// (non-broadway qualifiers are always 'explicit').
const NO_SIBLING_CONFLICT_PAIRS = {
  broadway: { 'off-broadway': ['explicit'] },
  'off-broadway': { broadway: ['explicit', 'jsonld-location'] },
  'west-end': { 'off-broadway': ['explicit'], broadway: ['explicit', 'canonical-path', 'jsonld-location'] },
  'off-west-end': { 'off-broadway': ['explicit'], broadway: ['explicit', 'canonical-path', 'jsonld-location'] },
  tour: { 'off-broadway': ['explicit'], broadway: ['explicit', 'canonical-path', 'jsonld-location'] },
};

/**
 * Does this page's market signal contradict the show it was filed under?
 *
 * @param {{showCategory?:string, siblingCategories?:string[], signal:null|{category:string,strength:string}}} p
 * @returns {null|{rule:'regional-sibling'|'measured-pair'}}
 */
function decideCrossMarketConflict({ showCategory, siblingCategories, signal }) {
  if (!signal || !showCategory || signal.category === showCategory) return null;
  if (showCategory === 'regional') {
    return Array.isArray(siblingCategories) && siblingCategories.includes(signal.category)
      ? { rule: 'regional-sibling' } : null;
  }
  const trusted = (NO_SIBLING_CONFLICT_PAIRS[showCategory] || {})[signal.category];
  return trusted && trusted.includes(signal.strength) ? { rule: 'measured-pair' } : null;
}

module.exports = {
  PAGE_MARKET_QUALIFIERS,
  NO_SIBLING_CONFLICT_PAIRS,
  detectPageMarketSignal,
  detectPageMarketQualifier,
  decideCrossMarketConflict,
};
