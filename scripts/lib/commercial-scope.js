'use strict';

const { isBroadwayCategory } = require('./venue-classification');

/**
 * commercial-scope.js — canonical scope + designation rules for the
 * commercial-research pipeline (deep-research, batch, backfill, queue
 * writers, sweep, apply).
 *
 * SCOPE TRAP: shows.json has BOTH `market` and `category`, and they mean
 * different things. `market` is the city ('broadway' = NYC, 'west-end' =
 * London) — every Off-Broadway show has market:'broadway'. The market tier
 * lives in `category` ('broadway' | 'off-broadway' | 'west-end' |
 * 'off-west-end' | 'regional'; Broadway is the default so it may be unset).
 * Filtering commercial research on `market` let 25+ Off-Broadway shows leak
 * into commercial.json and the research queue (2026-07-14). Always gate on
 * `category` via isCommercialScope() — never re-derive inline.
 */

/**
 * Is this show in scope for commercial research? Broadway only —
 * capitalization/recoupment data models NYC commercial productions;
 * Off-Broadway and West End have different financial structures and are
 * explicitly out of scope.
 *
 * Missing/unknown shows return false: a slug that doesn't resolve to
 * shows.json should never be researched on spec.
 *
 * @param {object|null|undefined} show — a shows.json entry
 * @returns {boolean}
 */
function isCommercialScope(show) {
  if (!show || typeof show !== 'object') return false;
  if (show._devOnly) return false;
  return isBroadwayCategory(show);
}

/**
 * Canonical designation criteria for research prompts. Every LLM prompt that
 * asks for a designation MUST embed this block — a bare name list made
 * o4-mini-deep call Glengarry Glen Ross (limited run, recouped in 9 weeks)
 * a "Miracle" (2026-04-12). Definitions mirror src/config/commercial.ts.
 */
const DESIGNATION_CRITERIA = `Designation — pick EXACTLY one, using these criteria:
- Miracle: long-running mega-hit with extraordinary returns — recouped AND has run (or clearly will run) roughly 10+ years with massive profit multiples (Hamilton, Wicked, The Lion King). Recouping fast is NOT enough; a limited run can NEVER be a Miracle.
- Windfall: open-ended commercial run that recouped and turned a solid profit, but is not a decade-defining phenomenon.
- Easy Winner: LIMITED engagement (planned closing date, often a star-driven play) that recouped during its run — even if it recouped very fast or broke house records.
- Trickle: roughly broke even or made a modest profit.
- Fizzle: closed without recouping, returned roughly 30% or more of its capitalization.
- Flop: closed without recouping, returned less than 30% of its capitalization.
- Nonprofit: produced by a nonprofit theater (Lincoln Center, Roundabout, MTC, Second Stage) — subscriber-funded, no traditional investor recoupment.
- TBD: still running and too early to tell, or insufficient data to judge.`;

/**
 * Resolve a pending/commercial entry to its shows.json record for scope
 * checks. Pending keys can be year-suffixed show IDs (ragtime-2025) while
 * shows.json may key the same production as a bare slug (ragtime), and
 * entries usually — but not always — carry entry.slug. Returns null when
 * nothing resolves (caller decides: apply paths let unresolved through, the
 * add-ahead-of-shows.json flow is supported).
 *
 * @param {Record<string, object>} showsBySlug — map keyed by slug AND id
 * @param {string} key — the pending/commercial key
 * @param {object} [entry] — the entry (for entry.slug)
 * @returns {object|null}
 */
function resolveScopeShow(showsBySlug, key, entry) {
  if (entry && entry.slug && showsBySlug[entry.slug]) return showsBySlug[entry.slug];
  if (showsBySlug[key]) return showsBySlug[key];
  const stripped = key.replace(/-\d{4}$/, '');
  if (stripped !== key && showsBySlug[stripped]) return showsBySlug[stripped];
  return null;
}

module.exports = { isCommercialScope, DESIGNATION_CRITERIA, resolveScopeShow };
