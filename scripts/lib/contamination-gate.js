'use strict';

/**
 * contamination-gate.js — pure block/pass decision for
 * `audit-review-contamination.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * 39k-file corpus scan. The split exists because review-texts live in a separate
 * private repo that data bots mutate every ~2min: `--strict` (block on ANY
 * strict-class hit) therefore reddened the trunk for every unrelated code push
 * whenever a single pre-existing/parallel C/E/F file existed. `--gate` blocks only
 * on a genuine integrity CATASTROPHE:
 *   - a cross-market leak (class A: another show's reviews shown) — ZERO tolerance, or
 *   - a mass-contamination spike: strict-class total beyond `floor`.
 * Single-file C/E/F drift is surfaced in the log but does NOT block. Same philosophy
 * as audit-text-quality --gate and the check-corpus-drift.yml split.
 *
 * @param {{crossMarketLeaks:number, strictHits:number, floor:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockContaminationGate({ crossMarketLeaks, strictHits, floor }) {
  return crossMarketLeaks > 0 || strictHits > floor;
}

// Classes counted toward `strictHits` above (BRO-65). "wrong data SHOWN to
// users" (integrity): A cross-market, C domain mismatch, E unflagged roundup,
// F empty junk. B (false-positive wrongProduction) and D (pre-opening feature)
// are deliberately excluded — see the long rationale next to this class's
// detector logic in audit-review-contamination.js. Single source of truth
// with that script (which requires this module rather than redefining the
// set) so the CI gate and its regression tests can never drift apart on
// which classes are "integrity" vs "report-only".
const STRICT_CLASSES = new Set(['A', 'C', 'E', 'F']);

/**
 * Sums the `hits` buckets (keyed `<ClassLetter>_description`, e.g.
 * `C_domain_mismatch`) whose class letter is in STRICT_CLASSES.
 * @param {Record<string, unknown[]>} hits
 * @returns {number}
 */
function countStrictHits(hits) {
  return Object.entries(hits)
    .filter(([k]) => STRICT_CLASSES.has(k.split('_')[0]))
    .reduce((sum, [, arr]) => sum + arr.length, 0);
}

/**
 * True when the canonical rebuild predicate already excludes this review file
 * from scoring (rejectionReason, wrongShow, noTextOrScoreSignal, ...). The
 * audit's shown-to-users classes (A/C/D/E) must not count such a file: it
 * cannot reach a score or a page, so a hit is noise that re-reddens
 * `--strict` every time a bot writes a flagless stub / ensemble-rejected /
 * "Wrong show" tier file (BRO-973: 6 of the 13 live strict hits). Delegates to
 * isIncludableForRebuild so it can never drift from what rebuild really
 * excludes. Lazy require keeps this module cheap for the gate-only callers.
 * Pass `show` and `filePath` exactly as rebuild-all-reviews.js does: without
 * them the predicate is stricter than rebuild (tour-stop text rules, duplicateOf
 * recovery and wrongShow/wrongProduction vetoes all depend on them).
 * @param {object} data parsed review-text file
 * @param {object} [show] shows.json entry
 * @param {string} [filePath] path.join(showDir, file)
 * @returns {boolean}
 */
function isAlreadyExcludedFromScoring(data, show, filePath) {
  const { isIncludableForRebuild } = require('./review-guards');
  return !isIncludableForRebuild(data, show, filePath);
}

module.exports = { shouldBlockContaminationGate, STRICT_CLASSES, countStrictHits, isAlreadyExcludedFromScoring };
