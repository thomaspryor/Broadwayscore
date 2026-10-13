'use strict';
/**
 * Does a review-text filename belong to this outlet + critic? (BRO-3943)
 * Filenames are `<outlet>--<critic>[-suffix].json`. The match needs the
 * outlet AND the critic: a critic-name-only match let a roundup excerpt
 * attach to a different outlet's file for a same-named critic.
 *
 * Edition variants of one outlet (`timeout` vs `timeout-london`, where the
 * file was renamed by URL edition) count as the same outlet: the outlet
 * segments must be equal or one must be the other plus a `-<edition>` tail.
 */
function criticMatches(rest, criticNorm) {
  return rest.startsWith(criticNorm + '.json') || rest.startsWith(criticNorm + '-');
}

function sameOutletFamily(segment, outletNorm) {
  return segment === outletNorm ||
    segment.startsWith(outletNorm + '-') ||
    outletNorm.startsWith(segment + '-');
}

function matchesOutletCriticFile(file, outletNorm, criticNorm) {
  const i = file.indexOf('--');
  if (i < 0) return false;
  return sameOutletFamily(file.slice(0, i), outletNorm) && criticMatches(file.slice(i + 2), criticNorm);
}
module.exports = { matchesOutletCriticFile };
