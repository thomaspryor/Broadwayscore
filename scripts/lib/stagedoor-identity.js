/**
 * Stagedoor archive identity (BRO-3615, follow-up to BRO-3610).
 *
 * scrape-stagedoor-critics.js stamps `title` from OUR OWN show record on two of
 * its three match paths (known-missing fast path, SERP discovery), so a
 * read-time `title` check passes by construction there. The writer now also
 * persists `pageTitle`, the heading actually scraped off the fetched
 * critic-reviews page, on every path; the read-time guard verifies it when
 * present. Archives written before this change have no pageTitle and fall back
 * to the title + ourShowId checks.
 */
const { pageTitleConfirmsShow } = require('./show-matching');

function buildArchiveData({ show, reviews, pageTitle, today }) {
  return {
    stagedoorId: show.id,
    stagedoorUrl: `/${show.category}/${show.id}-${show.slug}/critic-reviews`,
    title: show.title,
    pageTitle: pageTitle ? String(pageTitle).trim() : null,
    ourShowId: show.ourShowId,
    criticReviews: reviews,
    fetchedAt: today,
  };
}

function isArchiveIdentityMismatch(data, showId, showTitle) {
  if (!data) return true;
  if (data.ourShowId && data.ourShowId !== showId) return true;
  if (!pageTitleConfirmsShow(data.title || '', showTitle)) return true;
  if (data.pageTitle && !pageTitleConfirmsShow(data.pageTitle, showTitle)) return true;
  return false;
}

module.exports = { buildArchiveData, isArchiveIdentityMismatch };
