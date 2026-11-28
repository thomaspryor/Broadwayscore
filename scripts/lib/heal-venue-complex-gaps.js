/**
 * BRO-7403: self-heal for unlinked venue-complex sub-venue slugs.
 * New shows at multi-stage venues keep creating venue strings that findCandidateGaps
 * flags; each time a human linked them by hand after the daily live-data test went
 * red (BRO-6201, 6708, 7008, 7013). This applies the same fix mechanically.
 * Pure: takes shows + defs, returns {defs (mutated copy), added}. Same function the
 * test uses (findCandidateGaps), so heal and gate cannot disagree.
 */
const { findCandidateGaps } = require('./venue-complex-audit');
const { slugify } = require('./url-slug');

// Slugs that match a complex by keyword but are a DIFFERENT venue. Add here, never unlink by hand.
const NOT_SUB_VENUES = new Set([]);

// Keyword overlap alone is a heuristic (BRO-155 Loft Story, BRO-3425 black box, BRO-447,
// BRO-7068 Skywalk were all false positives). Auto-link only when the venue string itself
// names the complex ("The Lion Theatre at Theatre Row" -> Theatre Row); the rest stay red for a human.
const norm = (t) => slugify(String(t || '')).replace(/-/g, ' ').trim(); // slugify folds diacritics (shared rule)
function namesComplex(def, complexSlug, cand) {
  const name = norm(def.name).replace(/^the /, '');
  if (!name) return false;
  return (cand.rawStrings || []).some((r) => ` ${norm(r)} `.includes(` ${name} `));
}

function healCandidateGaps(shows, complexDefs, categoryFilter, marketKey) {
  const gaps = findCandidateGaps(shows, complexDefs, categoryFilter, marketKey);
  const defs = JSON.parse(JSON.stringify(complexDefs));
  const added = {};
  // a slug matched by several complexes is ambiguous: never auto-link it
  const owners = {};
  for (const [c, list] of Object.entries(gaps)) for (const cand of list) (owners[cand.slug] ||= new Set()).add(c);
  for (const [complexSlug, candidates] of Object.entries(gaps)) {
    if (!Array.isArray(defs[complexSlug].subVenueSlugs)) continue;
    for (const cand of candidates) {
      const { slug } = cand;
      if (NOT_SUB_VENUES.has(slug)) continue;
      if (owners[slug].size > 1) continue;
      if (!namesComplex(defs[complexSlug], complexSlug, cand)) continue;
      if (defs[complexSlug].subVenueSlugs.includes(slug)) continue;
      defs[complexSlug].subVenueSlugs.push(slug);
      (added[complexSlug] ||= []).push(slug);
    }
  }
  return { defs, added };
}

module.exports = { healCandidateGaps, NOT_SUB_VENUES };
