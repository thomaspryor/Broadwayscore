/**
 * BRO-7403: self-heal for unlinked venue-complex sub-venue slugs.
 * New shows at multi-stage venues keep creating venue strings that findCandidateGaps
 * flags; each time a human linked them by hand after the daily live-data test went
 * red (BRO-6201, 6708, 7008, 7013). This applies the same fix mechanically.
 * Pure: takes shows + defs, returns {defs (mutated copy), added}. Same function the
 * test uses (findCandidateGaps), so heal and gate cannot disagree.
 */
const { findCandidateGaps } = require('./venue-complex-audit');

// Slugs that match a complex by keyword but are a DIFFERENT venue. Add here, never unlink by hand.
const NOT_SUB_VENUES = new Set([]);

function healCandidateGaps(shows, complexDefs, categoryFilter, marketKey) {
  const gaps = findCandidateGaps(shows, complexDefs, categoryFilter, marketKey);
  const defs = JSON.parse(JSON.stringify(complexDefs));
  const added = {};
  for (const [complexSlug, candidates] of Object.entries(gaps)) {
    if (!Array.isArray(defs[complexSlug].subVenueSlugs)) continue;
    for (const { slug } of candidates) {
      if (NOT_SUB_VENUES.has(slug)) continue;
      if (defs[complexSlug].subVenueSlugs.includes(slug)) continue;
      defs[complexSlug].subVenueSlugs.push(slug);
      (added[complexSlug] ||= []).push(slug);
    }
  }
  return { defs, added };
}

module.exports = { healCandidateGaps, NOT_SUB_VENUES };
