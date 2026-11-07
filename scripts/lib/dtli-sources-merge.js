'use strict';

// BRO-5357: merging a DTLI excerpt into a review file must also record 'dtli'
// in `sources`, or provenance says the row never came from DTLI.
// A row that already holds an excerpt still matched a DTLI row, so it gets the
// provenance too (the mj-2022 Isherwood rows had excerpts but no 'dtli').
// Returns true when the review changed.
function applyDtliExcerpt(review, dtliReview) {
  let changed = false;
  const hasExcerpt = review.dtliExcerpt && review.dtliExcerpt.length >= 20;
  if (!hasExcerpt) {
    review.dtliExcerpt = dtliReview.excerpt;
    review.dtliThumb = dtliReview.thumb || review.dtliThumb;
    if (!review.url && dtliReview.url) review.url = dtliReview.url;
    changed = true;
  }
  if (!(review.sources || []).includes('dtli')) {
    const sources = new Set(review.sources || []);
    if (review.source) sources.add(review.source);
    sources.add('dtli');
    review.sources = Array.from(sources);
    changed = true;
  }
  return changed;
}

module.exports = { applyDtliExcerpt };
