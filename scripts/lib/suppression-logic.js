/**
 * suppression-logic.js
 *
 * Closes the gap BRO-2409 identified: every existing dedup mechanism
 * (fix-circular-duplicate-pairs.js's mutual-pair audit, the CI
 * audit-duplicate-of-url-mismatch.js / heal-orphaned-duplicate-pointers.js
 * self-heals) requires an EXISTING duplicateOf/duplicateTextOf pointer to
 * even find a same-URL pair. `rebuild-reviews.yml` runs two of those repairs
 * back-to-back as independent pre-rebuild steps; each can legitimately clear
 * its OWN half of an A<->B cycle (one healing a stale url-mismatch on A, the
 * other separately healing an orphaned pointer on B) with no knowledge of the
 * other's action. The result is a same-URL pair with ZERO pointer on either
 * side — invisible to every one of those audits, because they all start from
 * "does a pointer exist," and both members silently score
 * (rebuild-all-reviews.js emits the article twice). Confirmed live:
 * the-winslow-boy-2013 nytimes--ben-brantley.json /
 * nytimes--charles-isherwood.json, one shared URL, neither field set on
 * either file.
 *
 * findFullyUnsuppressedSameUrlGroups() is the detector for that specific
 * gap — a same-(outlet,url) cluster where NO member points at another member
 * via duplicateOf/duplicateTextOf. chooseSameUrlCanonical() is the repair
 * decision: it reuses fix-circular-duplicate-pairs.js's chooseCanonical
 * (already placeholder-byline aware since card #1907) via a deterministic
 * pairwise fold, so a cluster with a placeholder byline (outlet-name-as-
 * byline, "Staff", "Unknown", …) alongside a real one NEVER canonicalizes
 * the placeholder — the second half of this ticket's title. Reusing
 * chooseCanonical rather than re-deriving a ranking here is deliberate: it is
 * the one already-tested, already-fixed canonical-choice function in this
 * codebase, and re-implementing a parallel ranking is exactly the kind of
 * drift that let the placeholder-byline gap open in the first place.
 *
 * Pure + data-free so it unit-tests against fixtures (CLAUDE rule 15). The
 * driver script (scripts/fix-unflagged-same-url-clusters.js) supplies the
 * on-disk records and performs the writes.
 */

'use strict';

const { canonicalReviewUrl, outletOf } = require('./review-url-clusters');

/**
 * Strip query/hash/trailing slash so scrape-variant URLs collapse. Re-exported
 * (not re-implemented) from review-url-clusters.js's canonicalReviewUrl — the
 * SAME "same URL" definition the byline-explosion detector already uses, so
 * the two "is this one article" checks in this codebase can never drift out
 * of sync with each other again (the exact class of bug BRO-2409's own
 * root-cause fix targeted one layer down, between normalizeUrl and
 * stripTrivial).
 */
const canonicalUrl = canonicalReviewUrl;

/**
 * Outlet identity for grouping — prefer the `<outletId>--<critic>.json`
 * filename prefix (the canonical outlet id at write time) over the free-text
 * `data.outlet` display field, which is inconsistent across siblings (e.g.
 * "New York Times" vs "The New York Times" — see the-play-that-goes-wrong-2017
 * in the real corpus). Delegates to review-url-clusters.js's outletOf (not a
 * parallel reimplementation): that function ALSO folds diacritics and strips
 * punctuation, added specifically because "WhatsOnStage" vs "What's On Stage"
 * once split one real cluster into two groups — reusing it means this
 * detector inherits that fix instead of needing its own copy of it.
 *
 * @param {string} file basename, e.g. "nytimes--ben-brantley.json"
 * @param {object} data parsed record
 * @returns {string}
 */
function outletKeyOf(file, data) {
  return outletOf({ file, outlet: data && (data.outletId || data.outlet) });
}

/**
 * Group same-show review records by (outlet, url) and return only the groups
 * that are FULLY UNSUPPRESSED: 2+ members share one URL and no member's
 * duplicateOf/duplicateTextOf points at ANOTHER member of the same group. A
 * pointer aimed outside the group (a stale reference to a file with a
 * different URL, or to itself) does not resolve the cluster either.
 *
 * @param {Array<{file:string, data:object}>} records every record in ONE show dir
 * @returns {Array<{outlet:string, url:string, members:Array<{file:string,data:object}>}>}
 */
function findFullyUnsuppressedSameUrlGroups(records) {
  const list = Array.isArray(records) ? records : [];
  const byKey = new Map();
  for (const r of list) {
    if (!r || !r.data || typeof r.file !== 'string') continue;
    const url = canonicalUrl(r.data.url);
    if (!url) continue;
    const key = `${outletKeyOf(r.file, r.data)}\n${url}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const groups = [];
  for (const [key, members] of byKey.entries()) {
    if (members.length < 2) continue;
    const names = new Set(members.map((m) => m.file));
    const hasInternalPointer = members.some((m) => {
      const d = m.data;
      const candidates = [d.duplicateOf, d.duplicateTextOf].filter((t) => typeof t === 'string' && t.endsWith('.json'));
      return candidates.some((t) => t !== m.file && names.has(t));
    });
    if (hasInternalPointer) continue;
    const [outlet, url] = key.split('\n');
    groups.push({ outlet, url, members });
  }
  return groups;
}

/**
 * Pick the single canonical member of a fully-unsuppressed same-URL group by
 * folding fix-circular-duplicate-pairs.js's chooseCanonical pairwise across
 * every member. Sorting by filename before folding makes the result
 * independent of the caller's input order — chooseCanonical's tiebreak chain
 * is priority-based (recovery guard > byline/placeholder > misspelling >
 * attestation > score > age > filename), not a strict total order under
 * arbitrary fold order, so fixing the fold order is what keeps this
 * deterministic.
 *
 * `chooseCanonicalFn` may return `{skip: true}` for a pair (e.g.
 * fix-circular-duplicate-pairs.js's chooseCanonicalForRebuild, when both
 * members are cross-market class-A contaminated) — that propagates as a
 * whole-group skip rather than picking a winner anyway, the same
 * fail-safe fix-circular-duplicate-pairs.js's own audit() applies to a
 * 2-cycle it can't safely resolve.
 *
 * @param {Array<{file:string, data:object}>} members 2+ records sharing one (outlet,url)
 * @param {(aName:string, aData:object, bName:string, bData:object) => {canonical:string, loser:string, reason:string, skip?:boolean}} chooseCanonicalFn
 *   injected so this stays pure/testable without requiring the driver script
 * @returns {{canonical:string|null, losers:string[], reason:string|null, skip?:boolean}}
 */
function chooseSameUrlCanonical(members, chooseCanonicalFn) {
  const list = Array.isArray(members) ? members.slice() : [];
  if (list.length === 0) return { canonical: null, losers: [], reason: null };
  if (typeof chooseCanonicalFn !== 'function') {
    throw new TypeError('chooseSameUrlCanonical requires a chooseCanonicalFn (e.g. fix-circular-duplicate-pairs.js chooseCanonical)');
  }
  list.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  let winner = list[0];
  let reason = null;
  for (let i = 1; i < list.length; i++) {
    const challenger = list[i];
    const verdict = chooseCanonicalFn(winner.file, winner.data, challenger.file, challenger.data);
    if (verdict.skip) {
      return { canonical: null, losers: [], reason: verdict.reason, skip: true };
    }
    if (verdict.canonical !== winner.file) {
      // The winner changed — this IS why the new winner is winning (so far).
      winner = challenger;
      reason = verdict.reason;
    } else if (reason === null) {
      // First comparison this file has won (either the opening bout, or its
      // first successful defense after taking over) — record why. A LATER
      // defense that doesn't change the winner is NOT recorded: for a 3+
      // member fold, overwriting `reason` on every iteration regardless of
      // outcome would let the final pairwise comparison's reason overwrite
      // (and misdescribe) an earlier, still-true reason the SAME winner
      // already earned — this string is written verbatim into the on-disk
      // duplicateReason audit trail by the driver's fix(), so it must
      // describe the actual basis for the winner's standing, not just
      // whichever comparison happened to run last.
      reason = verdict.reason;
    }
  }
  return {
    canonical: winner.file,
    losers: list.filter((m) => m.file !== winner.file).map((m) => m.file),
    reason,
  };
}

module.exports = {
  canonicalUrl,
  outletKeyOf,
  findFullyUnsuppressedSameUrlGroups,
  chooseSameUrlCanonical,
};
