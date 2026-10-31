// Pure write decisions for extract-dtli-reviews.js (BRO-5288).
//
// The 2026-10-13 review refresh (broadway-review-texts c94cf8756) wrote 216
// DTLI rows, and three gaps let bad ones through:
//   1. Every archived DTLI page became a show folder, even when its file name
//      was a stale or DTLI-slug id that shows.json does not have
//      (heathers-the-musical-2025, the-other-place-2026, purpose, ...).
//      safeWriteReview's date-plausibility check looks the show up by folder
//      name, so for those folders it checked nothing and 2003/2013/2014
//      reviews landed as if they were current.
//   2. A brand-new row from an earlier production of a title (NYT 2014 for a
//      2026 King Lear) was still written; the write guard only parked it in
//      _pending/, and every refresh parked it again.
//   3. When DTLI names a different critic than the stored byline at the same
//      canonical file name (Side Show 2014: DTLI "David Cote", page byline
//      "Adam Feldman"), findExistingReviewFile rightly refused the file as a
//      merge target, and the fallback write then went to that same path and
//      replaced the byline with the weaker aggregator one.

const { evaluateDatePlausibility } = require('./date-plausibility');
const { storedCriticConflicts } = require('./review-normalization');

// Gap 2: a NEW row dated more than 180 days before this production's earliest
// date (outside priorRuns/tourLegs) is another production's review. Same
// decision safeWriteReview uses to quarantine it to _pending/, so nothing that
// used to be written live is now dropped; the row is just not re-parked on
// every refresh. Existing files are left to flag-wrong-production-by-date.js.
function newRowPredatesProduction({ publishDate, show }) {
  if (!show || !publishDate) return { skip: false };
  const verdict = evaluateDatePlausibility({ review: { publishDate }, show });
  if (verdict.implausible) {
    return {
      skip: true,
      reason: `publishDate ${publishDate} is ${verdict.daysBefore}d before ${show.id}'s earliest date ${verdict.earliestDate}`,
    };
  }
  return { skip: false };
}

// Gap 3: the file at the canonical path already names a different real
// critic. DTLI's critic column is an aggregator guess; the stored byline came
// from the review page or a human fix, so it is never overwritten from here.
function canonicalSlotNamesOtherCritic(incomingCritic, onDisk) {
  return !!onDisk && storedCriticConflicts(incomingCritic, onDisk);
}

module.exports = { newRowPredatesProduction, canonicalSlotNamesOtherCritic };
