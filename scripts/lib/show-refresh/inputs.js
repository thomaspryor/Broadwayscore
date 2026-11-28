'use strict';
/**
 * BRO-8056 phase 1b: one place that turns raw core-data files into the inputs
 * computeOneShow needs. data-core.ts (the build) and the show-refresh
 * publisher both call it, so a refreshed show is computed from inputs shaped
 * exactly like the build's.
 *
 * Pure: takes parsed JSON, returns indexes. No fs, no clock.
 *
 * @param {object} raw
 * @param {{shows: object[]}} raw.showsData - data/shows.json
 * @param {object[]} raw.reviews - data/reviews.json `.reviews` (critic reviews)
 * @param {object[]} raw.blogReviews - data/blog-reviews-for-scoring.json `.reviews`
 * @param {object[]} raw.audience - data/audience.json `.audience`
 * @param {object[]} raw.buzz - data/buzz.json `.threads`
 */
const { partitionShowRows } = require('../show-row-guard');

function groupByShowId(list) {
  const m = new Map();
  for (const r of list) {
    const arr = m.get(r.showId);
    if (arr) arr.push(r);
    else m.set(r.showId, [r]);
  }
  return m;
}

function buildShowInputs(raw) {
  const partition = partitionShowRows(raw.showsData && raw.showsData.shows);
  return {
    /** Rows page generation can render (malformed rows dropped; see show-row-guard). */
    shows: partition.valid,
    skipped: partition.skipped,
    /** Critic reviews per show, in reviews.json order. */
    reviewsByShowId: groupByShowId(raw.reviews || []),
    /** Blog reviews per show, in file order; scored after the critic reviews. */
    blogReviewsByShowId: groupByShowId(raw.blogReviews || []),
    audience: raw.audience || [],
    buzz: raw.buzz || [],
  };
}

/** The shows getAllShows() computes (dev-only rows excluded), in file order. */
function computableShows(inputs) {
  return inputs.shows.filter(show => !show._devOnly);
}

module.exports = { buildShowInputs, computableShows, groupByShowId };
