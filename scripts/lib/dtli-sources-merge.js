'use strict';

// BRO-5357: merging a DTLI excerpt into a review file must also record 'dtli'
// in `sources`, or provenance says the row never came from DTLI.
// Returns true when the review changed.
function applyDtliExcerpt(review, dtliReview) {
  const hasExcerpt = review.dtliExcerpt && review.dtliExcerpt.length >= 20;
  if (hasExcerpt) return false;
  review.dtliExcerpt = dtliReview.excerpt;
  review.dtliThumb = dtliReview.thumb || review.dtliThumb;
  if (!review.url && dtliReview.url) review.url = dtliReview.url;
  const sources = new Set(review.sources || []);
  if (review.source) sources.add(review.source);
  sources.add('dtli');
  review.sources = Array.from(sources);
  if (!review.source) review.source = review.sources[0];
  return true;
}

module.exports = { applyDtliExcerpt };
