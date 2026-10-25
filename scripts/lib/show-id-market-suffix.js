/**
 * Show-id market suffix vs category (2026 data audit, BRO-4315 S8-T1).
 *
 * A show id is a live URL minted once as `<base>[-<market>][-<year>]`. The
 * Official London Theatre loop used to hardcode category west-end, so ~96
 * Off West End rows were minted `-west-end-YYYY` and later re-categorised by
 * venue without their id following (root cause fixed in 5c0bfd86). This is
 * the pure decision behind tests/unit/show-id-market-suffix.test.mjs: does
 * the id's market suffix agree with the row's category?
 *
 *   west-end      id ends `-west-end` (optionally `-YYYY`)
 *   off-west-end  id ends `-off-west-end` (optionally `-YYYY`)
 *   off-broadway  id ends `-off-broadway` (optionally `-YYYY`)
 *   anything else (broadway, tour, regional) carries no market suffix
 *
 * The west-end rule is a plain "ends with -west-end" test on purpose:
 * `noises-off-west-end-2023` is the West End Noises Off, not an Off West End
 * row, and only the category can tell the two readings apart.
 *
 * Year drift is a separate rule with its own module (id-year-drift.js).
 */

'use strict';

const YEAR = '(?:-\\d{4})?$';
const CATEGORY_ID_RE = {
  'west-end': new RegExp(`-west-end${YEAR}`),
  'off-west-end': new RegExp(`-off-west-end${YEAR}`),
  'off-broadway': new RegExp(`-off-broadway${YEAR}`),
};
const ANY_MARKET_RE = new RegExp(`-(?:off-west-end|west-end|off-broadway)${YEAR}`);

/**
 * @returns {null | { id, category, reason }} null when the id agrees with
 *   the category (or the row is skipped), a hit otherwise.
 */
function marketSuffixMismatch(show) {
  if (!show || typeof show !== 'object' || show._devOnly) return null;
  const { id, category } = show;
  if (typeof id !== 'string' || !id || typeof category !== 'string') return null;
  const want = CATEGORY_ID_RE[category];
  if (want) {
    if (want.test(id)) return null;
    return { id, category, reason: `a ${category} row needs an id ending -${category}[-YYYY]` };
  }
  if (!ANY_MARKET_RE.test(id)) return null;
  return { id, category, reason: `a ${category} row carries a market suffix` };
}

/** Every mismatched row, in shows.json order. */
function findMarketSuffixMismatches(shows) {
  const hits = [];
  for (const show of Array.isArray(shows) ? shows : []) {
    const hit = marketSuffixMismatch(show);
    if (hit) hits.push(hit);
  }
  return hits;
}

/**
 * The id an Off West End row minted with a West End suffix should carry:
 * `relics-west-end-2026` → `relics-off-west-end-2026`. null when the id has
 * no plain `-west-end` suffix to swap.
 */
function offWestEndIdFor(id) {
  if (typeof id !== 'string' || CATEGORY_ID_RE['off-west-end'].test(id)) return null;
  const m = id.match(/^(.+)-west-end(-\d{4})?$/);
  return m ? `${m[1]}-off-west-end${m[2] || ''}` : null;
}

module.exports = { marketSuffixMismatch, findMarketSuffixMismatches, offWestEndIdFor };
