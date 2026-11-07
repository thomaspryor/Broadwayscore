'use strict';

/**
 * non-review-gate.js — pure block/pass decision for
 * `audit-non-reviews.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * corpus scan, matching contamination-gate / duplicate-of-gate.
 *
 * The catastrophe class is a SCORED review whose text is a definitive wrong-page
 * newspaper OCR — a weather page (`weather_page`) or sports scoreboard
 * (`sports_page`). These are user-facing data-correctness failures: an LA Times
 * weather page once shipped scored 88 and a Chicago Tribune sports page scored 72,
 * both full-page OCR of the wrong article surfaced on a show page. The definitive
 * classes carry ZERO false positives across 34k scored reviews, so — like a
 * cross-market leak in contamination-gate — a single hit is zero-tolerance and
 * blocks the trunk (floor defaults to 0). It is NOT auto-healable on the timescale
 * that matters: the page is scored and visible until a human flags/deletes it.
 *
 * Soft heuristic classes (obituary/preview/interview/junk/paywall/css) are NOT
 * counted here — they FP on real reviews that merely mention a death or carry
 * scrape boilerplate (verified 72 WSJ/HuffPost FPs), so they stay advisory in the
 * audit-review-quality cron, never a hard gate. The full `--strict` definitive
 * check also runs daily in check-corpus-drift.yml as a non-blocking backstop.
 *
 * @param {{definitiveHits:number, floor?:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockNonReviewGate({ definitiveHits, floor = 0 }) {
  return definitiveHits > floor;
}

module.exports = { shouldBlockNonReviewGate };
