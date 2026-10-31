'use strict';
const { showRecencyKey, NO_DATE_SENTINEL } = require('./collection-priority');

/**
 * True when the show's best-known date (openingDate, else previewsStartDate)
 * is within windowMs of `today`. Shows with no usable date are NOT in-window.
 */
function inOpeningWindow(show, today, windowMs) {
  const key = showRecencyKey(show);
  if (key === NO_DATE_SENTINEL) return false;
  const t = new Date(key).getTime();
  if (Number.isNaN(t)) return false;
  return Math.abs(today - t) <= windowMs;
}

module.exports = { inOpeningWindow };
