'use strict';

const { isBroadwayCategory } = require('./venue-classification');
const { levenshteinDistance } = require('./deduplication');

/**
 * Report likely phantom Broadway theaters against the independent metadata
 * registry, never against the theater map derived from the same show records.
 * Suggestions are diagnostic only: historical names and ambiguous matches
 * must not silently rename a venue or move its shows.
 */
function reportVenueNameTypos(shows, report = console.warn, theaterMetadata = require('../../data/theater-metadata.json')) {
  const keys = Object.keys(theaterMetadata).filter(key => key !== '_meta');
  const exactNames = new Set(keys);
  let count = 0;

  for (const show of shows) {
    if (!isBroadwayCategory(show) || typeof show.venue !== 'string' || exactNames.has(show.venue)) continue;
    const trimmed = show.venue.trim();
    // Generic fragments such as "Theatre" cannot identify an intended house.
    if (trimmed.replace(/\b(?:theatre|theater)\b/gi, '').trim().length < 4) continue;
    const name = trimmed.toLowerCase();
    const likely = keys.filter(key => {
      const canonical = key.toLowerCase();
      return canonical.includes(name) || name.includes(canonical) ||
        (Math.abs(name.length - canonical.length) <= 2 && levenshteinDistance(name, canonical) <= 2);
    });
    if (!likely.length) continue;
    report(`[Theater Scorecard] Near-miss venue ${JSON.stringify(show.venue)} (show: ${show.id}); likely intended theater: ${likely.map(key => JSON.stringify(key)).join(', ')}. Use the exact theater-metadata.json key to avoid a phantom theater entry.`);
    count++;
  }

  return count;
}

module.exports = { reportVenueNameTypos };
