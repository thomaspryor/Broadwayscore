/**
 * Pure classification function — returns {category, market} for a discovered show.
 *
 * Extracted from scripts/discover-new-shows.js so tests can require() the real
 * function per CLAUDE.md §15 (never copy logic into tests). Historical context:
 * Broadway shows shipped with null category+market for a month of opening nights
 * (Schmigadoon / Beaches / Rocky Horror / Joe Turner / Lost Boys) because the
 * creator's if/else-if chain had no else branch for Broadway. The fix added an
 * explicit default; this helper locks the invariant in one place.
 *
 * @param {{category?: string}} show  Intermediate discovery object (may set category, may not)
 * @returns {{category: string, market: string}}  Both always non-null.
 */
function classifyShow(show) {
  const c = show && show.category;
  if (c === 'off-broadway') return { category: 'off-broadway', market: 'broadway' };
  if (c === 'west-end')     return { category: 'west-end',     market: 'west-end' };
  if (c === 'off-west-end') return { category: 'off-west-end', market: 'west-end' };
  return { category: 'broadway', market: 'broadway' };
}

module.exports = { classifyShow };
