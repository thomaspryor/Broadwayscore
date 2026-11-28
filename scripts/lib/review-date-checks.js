'use strict';

/**
 * Ordinal-safe publishDate helpers for the audit/extract scripts (BRO-2843).
 * ~13% of review-text files store publishDate as "October 6th, 2022", which a
 * bare `new Date()` turns into Invalid Date; every comparison on it is then
 * false and the check silently takes its default branch. toDateMs
 * (date-utils.js) is the one place that handles those strings.
 */
const { toDateMs } = require('./date-utils');

/** publishDate string -> Date, or null when unreadable. */
function parsePublishDate(value) {
  const ms = toDateMs(value);
  return isNaN(ms) ? null : new Date(ms);
}

/**
 * True when the review was published more than 400 days before the show's
 * previews/opening (generous for early preview coverage): wrong production.
 * Unreadable dates on either side are never flagged.
 */
function isPublishedTooEarly(review, show) {
  if (!show || !review.publishDate) return false;
  const earliestDate = show.previewDate || show.openingDate;
  if (!earliestDate) return false;
  const pub = toDateMs(review.publishDate);
  const earliest = toDateMs(earliestDate);
  const daysBefore = (earliest - pub) / (1000 * 60 * 60 * 24);
  return daysBefore > 400;
}

module.exports = { parsePublishDate, isPublishedTooEarly };
