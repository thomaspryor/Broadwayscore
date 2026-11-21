'use strict';

// BRO-7498: Show Score can repeat an old production's excerpt without its URL
// or date. Compare only exact excerpts and the same named critic/outlet, never
// infer production metadata from a URL.
const fs = require('fs');
const path = require('path');
const { isReviewTextFile } = require('./review-text-sidecars');
const { normalizeDate } = require('./date-utils');
const { isHumanClearedWrongProduction } = require('./stale-flag-neutralization');

const fold = (value) => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() : '';

function isExcerptCandidate(review) {
  return !!review && !review.url && !review.publishDate && !review.fullText
    && !review.wrongProduction && !review._locked
    && review.assignedScore == null && !review.llmScore
    && !isHumanClearedWrongProduction(review)
    && !!fold(review.outletId) && !!fold(review.criticName)
    && !['unknown', 'unnamed', 'staff'].includes(fold(review.criticName))
    && fold(review.showScoreExcerpt).length >= 40;
}

// A rejection under an old folder is not proof that the review is wrong for
// this folder. Require a known date outside this run and every declared prior
// run. Undated rejected copies cannot establish which production is wrong.
function dateCouldBelongToShow(date, show) {
  const day = normalizeDate(date);
  if (!day) return true;
  const ms = Date.parse(day);
  return [show, ...(show.priorRuns || [])].some(run => {
    const start = normalizeDate(run.previewsStartDate || run.openingDate);
    if (!start) return true; // insufficient production identity to exclude
    const end = normalizeDate(run.closingDate);
    return ms >= Date.parse(start) - 180 * 86400000
      && (!end || ms <= Date.parse(end) + 30 * 86400000);
  });
}

function rejectedShowScoreExcerptReason(review, show, shows, reviewTextsDir) {
  if (!isExcerptCandidate(review) || !show || !fold(show.title)) return null;
  const excerpt = fold(review.showScoreExcerpt);
  for (const sibling of shows) {
    if (sibling.id === show.id || fold(sibling.title) !== fold(show.title)) continue;
    const dir = path.join(reviewTextsDir, sibling.id);
    let files;
    try { files = fs.readdirSync(dir); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files.filter(isReviewTextFile)) {
      let prior;
      try { prior = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (prior.wrongProduction !== true || prior.wrongProductionAutoCleared
          || prior.wrongProductionManualClear || prior.wrongProductionOverride
          || prior.humanReviewedWrongProduction === false) continue;
      if (fold(prior.outletId) !== fold(review.outletId)
          || fold(prior.criticName) !== fold(review.criticName)
          || fold(prior.showScoreExcerpt) !== excerpt) continue;
      // Historical gather filled missing dates with the folder show's opening
      // date. An unproven date equal to that fallback is not publication evidence.
      if (!prior.dateSource && normalizeDate(prior.publishDate) === normalizeDate(sibling.openingDate)) continue;
      if (dateCouldBelongToShow(prior.publishDate, show)) continue;
      return `Show Score excerpt matches a wrong-production review in ${sibling.id}/${file}`;
    }
  }
  return null;
}

module.exports = { isExcerptCandidate, rejectedShowScoreExcerptReason };
