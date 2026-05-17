/**
 * Shared classifyCategory predicate — JS mirror of src/lib/awards-scoring.ts.
 *
 * Returns { tier, revival } when the category name is recognized as one of
 * the Tony / DD / OCC / DL / Pulitzer award sub-categories the scoring
 * system understands, or null otherwise.
 *
 * MUST stay in lockstep with src/lib/awards-scoring.ts classifyCategory.
 * Adding a regex here without mirroring there (or vice versa) silently
 * mis-tiers the precursor noms tail. Codex /ship-check caught this
 * drifting after the DD 70th "Lead/Featured Performance" patterns were
 * added to TS but not to the JS mirror (2026-05-16).
 *
 * Importers:
 *   - scripts/derive-noms-pool-ceilings.js
 *   - scripts/lib/awards-schema-validator.js (precursor source validator)
 *   - scripts/enrich-awards-with-precursors.js (via the validator)
 */
function classifyCategory(category) {
  const c = String(category || '').toLowerCase();
  if (/revival of a musical|musical revival/.test(c)) return { tier: 'S', revival: true };
  if (/revival of a play|play revival/.test(c)) return { tier: 'S', revival: true };
  // Lortel "Outstanding Revival" — combined musical+play revival category (no type distinction)
  if (/^outstanding revival$/.test(c)) return { tier: 'S', revival: true };
  if (/best musical$|outstanding musical$|outstanding new (broadway|off-broadway) musical|outstanding production of a (broadway or off-broadway )?musical/.test(c)) return { tier: 'S', revival: false };
  if (/best play$|outstanding play$|outstanding new (broadway|off-broadway) play|outstanding production of a play/.test(c)) return { tier: 'S', revival: false };
  if (/^drama$/.test(c)) return { tier: 'S', revival: false };
  if (/best (original )?score|outstanding (new )?score|outstanding music\b|outstanding lyrics|outstanding music in a play/.test(c)) return { tier: 'A+', revival: false };
  if (/best book|outstanding book/.test(c)) return { tier: 'A+', revival: false };
  if (/direction|director/.test(c)) return { tier: 'A', revival: false };
  if (/choreograph/.test(c)) return { tier: 'A', revival: false };
  if (/distinguished performance/.test(c)) return { tier: 'A', revival: false };
  if (/best (actor|actress) in a (play|musical)|outstanding (actor|actress) in a (play|musical)/.test(c)) return { tier: 'A', revival: false };
  // Lead Performance (DD 70th+) / Lead Performer (OCC) / Lead Actor|Actress (Lortel) in a [Broadway|Off-Broadway] [play|musical]
  if (/outstanding lead (performance|performer|actor|actress) in an? (broadway |off-broadway )?(play|musical)/.test(c)) return { tier: 'A', revival: false };
  if (/featured (actor|actress)/.test(c)) return { tier: 'B', revival: false };
  // Featured Performance (DD 70th+) / Featured Performer (OCC) / Featured Actor|Actress (Lortel) variants
  if (/outstanding featured (performance|performer|actor|actress) in an? (broadway |off-broadway )?(play|musical)/.test(c)) return { tier: 'B', revival: false };
  if (/orchestration/.test(c)) return { tier: 'B', revival: false };
  if (/ensemble/.test(c)) return { tier: 'B', revival: false };
  if (/scenic|set design/.test(c)) return { tier: 'C', revival: false };
  if (/costume/.test(c)) return { tier: 'C', revival: false };
  if (/lighting/.test(c)) return { tier: 'C', revival: false };
  if (/sound/.test(c)) return { tier: 'C', revival: false };
  if (/projection design/.test(c)) return { tier: 'C', revival: false };
  if (/solo performance|solo show/.test(c)) return { tier: 'B', revival: false };
  if (/john gassner award/.test(c)) return { tier: 'C', revival: false };
  // NYDCC Best Foreign Play — S-tier like Best Play; foreign-authored Broadway productions
  if (/best foreign play/.test(c)) return { tier: 'S', revival: false };
  // Obie Award categories (Village Voice Off-Broadway, 1956–2019)
  if (/best new american play|outstanding new american play/.test(c)) return { tier: 'S', revival: false };
  if (/best new musical/.test(c)) return { tier: 'S', revival: false };
  // Obie "Best Performance" is a generic acting award (no lead/featured distinction)
  if (/\bbest performance\b/.test(c)) return { tier: 'B', revival: false };
  // Special/honorary career awards — recognized but intentionally worth 0 points; not a typo.
  if (/special achievement|body of work/.test(c)) return null;
  return null;
}

/**
 * Category names that classifyCategory() intentionally returns null for
 * (honorary/special awards, not typos). Used by the enricher to suppress
 * false "unknown category" warnings.
 */
const KNOWN_UNSCORED_CATEGORIES = new Set([
  'Special Achievement Award',
  'Outstanding Body of Work',
]);

module.exports = { classifyCategory, KNOWN_UNSCORED_CATEGORIES };
