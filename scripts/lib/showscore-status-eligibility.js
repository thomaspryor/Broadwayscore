'use strict';
// BRO-4876: which shows the ShowScore status refresh may open/close.
// A national tour's show-score-urls.json entry points at its parent or a
// sibling production's page (operation-mincemeat-tour-2026 -> the closed
// West End listing), so "Closed" there says nothing about the tour. Tour
// lifecycle belongs to the tour schedule/closing pipeline, which writes a
// closingDate; the refresh closed the tour with none, leaving 24 future stops.
function isShowScoreStatusEligible(show, ssUrls) {
  if (!show || !ssUrls || !ssUrls[show.id]) return false;
  if (show.status !== 'open' && show.status !== 'previews') return false;
  if (show.category === 'tour') return false;
  return true;
}
module.exports = { isShowScoreStatusEligible };
