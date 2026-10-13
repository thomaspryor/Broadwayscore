'use strict';
/**
 * Does a review-text filename belong to this outlet + critic? (BRO-3943)
 * Filenames are `<outlet>--<critic>[-suffix].json`. The match needs BOTH
 * halves: a critic-name-only match let a roundup excerpt attach to a
 * different outlet's file for a same-named critic.
 */
function matchesOutletCriticFile(file, outletNorm, criticNorm) {
  const expected = `${outletNorm}--${criticNorm}`;
  return file.startsWith(expected + '.json') || file.startsWith(expected + '-');
}
module.exports = { matchesOutletCriticFile };
