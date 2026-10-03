/**
 * Population selector for `reverify-stale-cv-promoted.js --cv-promoted-nonreview`
 * (BRO-4552, follow-up to BRO-4189).
 *
 * Selects review-text files excluded by a CV-promoted isNonReview stamp
 * (isNonReviewReason starts "CV-promoted (not a review):") on shows opened on
 * or after `openedSince`. These stay excluded until a FRESH contentVerification
 * exists, and nothing else re-runs CV on them (audit-stale-cv-hash only finds
 * stale-contentHash files). Human-adjudicated / locked files are never selected.
 */

const fs = require('fs');
const path = require('path');

const CV_PROMOTED_NON_REVIEW_PREFIX = 'CV-promoted (not a review):';
const MIN_TEXT_LENGTH = 200;

// Same human-adjudication gates as reverify-stale-cv-promoted.js isProtected().
function isHumanProtected(d) {
  return Boolean(
    d.wrongProductionManualClear === true ||
    d.wrongProductionOverride === true ||
    d.wrongShowOverride === true ||
    d.humanReviewedWrongProduction === false ||
    d._locked === true ||
    d.manualContentTier === 'complete' ||
    d.nonReviewOverride
  );
}

function isCvPromotedNonReviewCandidate(d) {
  if (!d || d.isNonReview !== true) return false;
  if (typeof d.isNonReviewReason !== 'string') return false;
  if (!d.isNonReviewReason.startsWith(CV_PROMOTED_NON_REVIEW_PREFIX)) return false;
  if (typeof d.fullText !== 'string' || d.fullText.length < MIN_TEXT_LENGTH) return false;
  return !isHumanProtected(d);
}

/**
 * @param {string} reviewTextsDir
 * @param {Array<{id:string, openingDate?:string}>} shows
 * @param {{openedSince?:string}} opts  ISO date; shows opened before it are skipped
 * @returns {Array<{showId:string, file:string}>}
 */
function selectCvPromotedNonReview(reviewTextsDir, shows, { openedSince } = {}) {
  const out = [];
  for (const show of shows) {
    if (openedSince && !(show.openingDate && show.openingDate >= openedSince)) continue;
    const dir = path.join(reviewTextsDir, show.id);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (!isCvPromotedNonReviewCandidate(d)) continue;
      if (alreadyReverified(d)) continue;
      out.push({
        showId: show.id,
        file,
        outletId: d.outletId || null,
        criticName: d.criticName || null,
        wrongShow: Boolean(d.wrongShow),
        wrongProduction: Boolean(d.wrongProduction),
        isNonReview: true,
        cvArticleType: d.contentVerification?.articleType || null,
        cvWrongArticle: d.contentVerification?.wrongArticle === true,
      });
    }
  }
  return out;
}

/**
 * All-or-none clear plan for one re-verified file (BRO-4552 review blocker):
 * clearing wrongShow/wrongProduction while isNonReview stays set would stamp a
 * permanent override (wrongProductionOverride/wrongShowOverride) that removes the
 * file from every future selection, stranding it excluded. So when a file carries
 * several flag families, clear them only if EVERY one is clearable.
 */
function planClear(data, result, clean) {
  const none = { clearWrong: false, wrongShowOnly: false, clearNonReview: false, heldBack: false };
  const hasWrong = Boolean(data.wrongShow || data.wrongProduction);
  if (!clean || (!hasWrong && !data.isNonReview)) return none;
  const articleConfidence = result.articleTypeConfidence || result.confidence;
  const wrongOk = !hasWrong || result.confidence === 'high';
  const nonReviewOk = !data.isNonReview || articleConfidence === 'high';
  if (!(wrongOk && nonReviewOk)) return { ...none, heldBack: true };
  return {
    clearWrong: hasWrong,
    wrongShowOnly: !data.wrongProduction,
    clearNonReview: Boolean(data.isNonReview),
    heldBack: false,
  };
}

// Files already re-verified from stored text keep isNonReview when refused; skip
// them so a --limit batch moves on instead of re-paying for the same first N files.
function alreadyReverified(d) {
  return d?.contentVerification?.reverifiedFrom === 'stored-fullText';
}

module.exports = {
  planClear,
  alreadyReverified,
  CV_PROMOTED_NON_REVIEW_PREFIX,
  isCvPromotedNonReviewCandidate,
  selectCvPromotedNonReview,
};
