'use strict';
// BRO-7931 #3: a WET run over hundreds of posts that matches none is a broken
// extractor/matcher, not a quiet day. Before this the run exited 0 ("5/5 green")
// while 0 of 940 posts matched for weeks.
const MIN_POSTS_FOR_ALARM = 50;
function wetZeroMatchProblem({ totalPosts, titleMatched, showFilter }) {
  if (showFilter) return null;
  if ((totalPosts || 0) >= MIN_POSTS_FOR_ALARM && !titleMatched) {
    return `WET zero-match: 0 of ${totalPosts} posts matched a London show (extractor/matcher regression?)`;
  }
  return null;
}
module.exports = { wetZeroMatchProblem, MIN_POSTS_FOR_ALARM };
