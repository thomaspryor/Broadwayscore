'use strict';

/**
 * Which shows may carry transferOf / transferredTo (BRO-6400). Pure, no IO.
 *
 * transferOf sits on the later production and names the one it came from;
 * transferredTo sits on the earlier production and names where it went. The
 * pair must be reciprocal (validate-data checks that separately).
 *
 * Two kinds of pair are allowed:
 *  1. A regional tryout and its transfer (the original use, 2026-07-11):
 *     transferredTo on the category:'regional' row, transferOf on the later
 *     row pointing at it.
 *  2. A main-stage production crossing the Atlantic: a West End / Off-West End
 *     production and its Broadway / Off-Broadway transfer, in either
 *     direction (Oedipus Wyndham's -> Studio 54, Oh, Mary! Lyceum -> Trafalgar).
 *
 * Anything else (two NYC rows, two London rows, a tour) stays out: same-market
 * moves use priorRuns, tours use tourOf / tourParent.
 */

const NYC = new Set(['broadway', 'off-broadway']);
const LONDON = new Set(['west-end', 'off-west-end']);

/** True when one show is an NYC main-stage row and the other a London one. */
function isCrossMarketPair(a, b) {
  if (!a || !b) return false;
  return (NYC.has(a.category) && LONDON.has(b.category)) || (LONDON.has(a.category) && NYC.has(b.category));
}

/**
 * Error text when `show[field]` -> `target` is not an allowed transfer pair,
 * else null. Existence, self-reference and reciprocity are checked by the
 * caller; this only covers which categories may be linked.
 */
function transferLinkCategoryError(show, field, target) {
  if (field === 'transferOf') {
    if (target.category === 'regional' || isCrossMarketPair(show, target)) return null;
    return `Show "${show.id}" transferOf "${target.id}" must point at a category:'regional' show or a production in the other market (Broadway <-> West End); got "${target.category}" from "${show.category}"`;
  }
  if (field === 'transferredTo') {
    if (show.category === 'regional' || isCrossMarketPair(show, target)) return null;
    return `Show "${show.id}" has transferredTo "${target.id}" but is category "${show.category}" (target "${target.category}"): only regional tryouts or Broadway <-> West End transfers carry transferredTo`;
  }
  return null;
}

/**
 * Every problem with the transfer links in `shows`, as error strings: a link to
 * a missing show or to itself, a one-way link, or a pair of categories that
 * may not be linked. validate-data and execute-approved-fix both use it, so an
 * approved plan cannot push a link the site build would reject.
 */
function transferLinkProblems(shows) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const problems = [];
  for (const s of shows) {
    for (const [field, reciprocal] of [['transferOf', 'transferredTo'], ['transferredTo', 'transferOf']]) {
      const ref = s[field];
      if (ref === undefined || ref === null) continue;
      const target = byId.get(ref);
      if (!target) {
        problems.push(`Show "${s.id}" ${field} "${ref}" does not reference an existing show`);
      } else if (ref === s.id) {
        problems.push(`Show "${s.id}" ${field} points at itself`);
      } else if (target[reciprocal] !== s.id) {
        problems.push(`Show "${s.id}" ${field} "${ref}" is not reciprocated — "${ref}" must set ${reciprocal}: "${s.id}"`);
      } else {
        const categoryError = transferLinkCategoryError(s, field, target);
        if (categoryError) problems.push(categoryError);
      }
    }
  }
  return problems;
}

module.exports = { isCrossMarketPair, transferLinkCategoryError, transferLinkProblems };
