'use strict';

// venue-write-guard-ok: read-only audit projection of existing shows.json values; never writes a venue.
const { hasRealImage } = require('./show-images');
const { hasActiveNoArtMarker } = require('./no-reliable-art');
const { isTourShow } = require('./tour-family');
const { isUkRegionalVenue } = require('./market-label');

// Use the earliest known date so a recent backfill cannot restart the grace period.
function resolveSinceMs(show) {
  const dates = [show.discoveredAt, show.openingDate, show.previewsStartDate]
    .map(value => value ? Date.parse(value) : NaN)
    .filter(value => !Number.isNaN(value));
  return dates.length ? Math.min(...dates) : null;
}

function normalizeImageAuditInputs(showsData, reviewsData, { nowMs = Date.now(), imageOptions } = {}) {
  if (!Array.isArray(showsData?.shows) || !showsData.shows.length) {
    throw new Error('Image coverage requires a nonempty shows.json shows array');
  }
  const rawReviews = Array.isArray(reviewsData) ? reviewsData : reviewsData?.reviews;
  if (!rawReviews || typeof rawReviews !== 'object') {
    throw new Error('Image coverage requires reviews.json review records');
  }
  const reviews = Array.isArray(rawReviews) ? rawReviews : Object.values(rawReviews);
  if (!reviews.length || reviews.some(r => !r || typeof r.showId !== 'string' || !r.showId)) {
    throw new Error('Image coverage requires nonempty reviews with showId');
  }
  const counts = new Map();
  for (const review of reviews) counts.set(review.showId, (counts.get(review.showId) || 0) + 1);
  return showsData.shows.map(show => ({
    id: show.id,
    title: show.title,
    category: show.category,
    city: show.city,
    venue: show.venue,
    hasImages: hasRealImage(show, imageOptions),
    noReliableArt: hasActiveNoArtMarker(show, nowMs),
    reviewCount: counts.get(show.id) || 0,
    sinceMs: resolveSinceMs(show),
    dispatchId: isTourShow(show) && show.tourOf ? show.tourOf : undefined,
  }));
}

// BRO-6901: acceptance is coverage of every scored UK/Chicago/DC regional row,
// including closed and undated rows. The dispatcher's grace period is separate.
function findRegionalImageGaps(normalized) {
  return normalized.filter(show => show.category === 'regional'
    && (show.city === 'chicago-il' || show.city === 'washington-dc'
      || (typeof show.city === 'string' && show.city.endsWith('-uk'))
      || isUkRegionalVenue(show.venue))
    && show.reviewCount > 0 && !show.hasImages && !show.noReliableArt);
}

module.exports = { normalizeImageAuditInputs, findRegionalImageGaps };
