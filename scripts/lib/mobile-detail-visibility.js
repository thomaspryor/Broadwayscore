// Which shows get a public/data/shows/{id}.json detail file. Shared by
// generate-mobile-show-details.js and the tests that read its output, so a
// test can tell a live file from an orphan the generator stopped writing
// (BRO-4825).
const { isPublishedShowFile } = require('./markets');

function scoredShowIds(reviews) {
  const ids = new Set();
  for (const review of reviews || []) {
    if (review.assignedScore != null) ids.add(review.showId);
  }
  return ids;
}

function isDetailVisible(show, scoredIds) {
  return isPublishedShowFile(show.category) &&
    (scoredIds.has(show.id) || show.status !== 'closed');
}

module.exports = { scoredShowIds, isDetailVisible };
