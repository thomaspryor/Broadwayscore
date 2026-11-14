'use strict';
/**
 * Pure decisions for rebuild-all-reviews.js's OB→Broadway transfer guard (BRO-4192).
 *
 * The guard flags an Off-Broadway review wrongProduction('ob-broadway-transfer')
 * when its URL also appears in the Broadway transfer's directory, on the theory
 * that the critic re-used the URL for the Broadway run. Two bugs:
 *
 *   1. It counted EVERY Broadway-dir URL, including a misfiled copy of the OB
 *      review itself (an OB-era review sitting in the Broadway dir). That copy
 *      is not Broadway coverage, so it must not supersede the OB original.
 *   2. The flag was sticky (flagged files are skipped on later runs), so once
 *      the misfiled Broadway copy was corrected the OB review stayed excluded
 *      forever. cats-the-jellicle-ball-off-broadway-2024 lost its NYT Critic's
 *      Pick (Jesse Green, 2024-06-20) this way.
 *
 * isValidBroadwayCopy() fixes (1); shouldClearStaleObTransfer() fixes (2).
 */

const { isEffectivelyWrongProductionOrShow } = require('./content-quality.js');

// Matches the rebuild's pre-opening guard (flags at 90+ days early), so a
// Broadway copy that can still ship under the Broadway show keeps counting.
const EARLY_GRACE_DAYS = 90;
// Open-ended OB runs (no closingDate): same horizon the pick audit uses.
const OPEN_RUN_DAYS = 400;

function toTime(d) {
  if (!d) return NaN;
  // "June 20th, 2024" → "June 20, 2024"
  const t = Date.parse(String(d).replace(/(\d)(st|nd|rd|th)\b/g, '$1'));
  return t;
}

function earliestDate(show) {
  return [show && show.previewsStartDate, show && show.openingDate].filter(Boolean).sort()[0] || null;
}

/**
 * Should this Broadway-dir record's URL count as Broadway coverage that can
 * supersede an OB review? Not if it is itself flagged wrong production/show,
 * and not if it is dated clearly before the Broadway run began (a misfiled
 * OB-era review). Undated records keep the historical behavior (count).
 */
function isValidBroadwayCopy(bwRecord, bwShow) {
  if (!bwRecord || !bwRecord.url) return false;
  const { effectivelyWrongProduction, effectivelyWrongShow } = isEffectivelyWrongProductionOrShow(bwRecord);
  if ((bwRecord.wrongProduction === true && effectivelyWrongProduction)
      || (bwRecord.wrongShow === true && effectivelyWrongShow)) return false;
  const start = earliestDate(bwShow);
  const pub = toTime(bwRecord.publishDate);
  if (start && !Number.isNaN(pub)) {
    if (pub < Date.parse(start) - EARLY_GRACE_DAYS * 86400000) return false;
  }
  return true;
}

/**
 * Is the record dated inside the OB show's own run (first preview/opening
 * through closing, with a small grace)? Positive evidence it covers THIS
 * production. Undated records return false.
 */
function isDatedWithinObRun(obRecord, obShow) {
  const start = earliestDate(obShow);
  const pub = toTime(obRecord && obRecord.publishDate);
  if (!start || Number.isNaN(pub)) return false;
  const grace = 14 * 86400000;
  if (pub < Date.parse(start) - grace) return false;
  const end = obShow.closingDate
    ? Date.parse(obShow.closingDate) + grace
    : Date.parse(start) + OPEN_RUN_DAYS * 86400000;
  if (pub > end) return false;
  return true;
}

/**
 * Should a previously set 'ob-broadway-transfer' flag be cleared? Only when:
 *   - the flag was set by this guard (reason matches, not operator-confirmed),
 *   - no VALID Broadway copy shares the URL any more, and
 *   - the review is dated inside the OB show's own run.
 * The last condition is deliberately conservative: OB dirs also hold reviews
 * of other productions (London runs, earlier revivals) that happen to carry
 * this flag, and clearing those would re-admit genuinely wrong reviews.
 */
function shouldClearStaleObTransfer(obRecord, sharedWithValidBroadwayCopy, obShow) {
  if (!obRecord || obRecord.wrongProduction !== true) return false;
  if (obRecord.wrongProductionReason !== 'ob-broadway-transfer') return false;
  if (obRecord.humanReviewedWrongProduction === true) return false;
  if (obRecord._locked === true) return false; // the release force-writes; never touch a locked file
  if (sharedWithValidBroadwayCopy) return false;
  return isDatedWithinObRun(obRecord, obShow);
}

module.exports = { isValidBroadwayCopy, isDatedWithinObRun, shouldClearStaleObTransfer, EARLY_GRACE_DAYS };
