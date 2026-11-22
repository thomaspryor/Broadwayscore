'use strict';
/**
 * BRO-8056 phase 1b: a show's slice is everything computeOneShow and the show
 * page read for that one show, and nothing else (no images map, no outlet
 * registry, no clock: those come from the build). Its hash names the immutable
 * store object show/<id>/<hash>.json and decides whether a show changed.
 *
 * Bump SLICE_VERSION whenever the slice's shape or meaning changes; the
 * golden-hash test (slice.test.mjs) fails until you do.
 */
const { stable, hash16 } = require('../live-score/core');
const { coverageGateDisabled } = require('../coverage-gate');

const SLICE_VERSION = 1;

/**
 * Index the per-show lookups once; sliceFor() is then O(reviews of that show).
 * @param {ReturnType<import('./inputs').buildShowInputs>} inputs
 * @param {object} extras
 * @param {Record<string, object>} [extras.consensusById] - data/critic-consensus.json `.shows`
 * @param {Record<string, object>} [extras.audienceBuzzById] - data/audience-buzz.json `.shows`
 * @param {{covByShowId: Map, scorePublicSinceByShowId: Map, coverageAckedShowIds: Set}} extras.coverageFloorInputs
 */
function indexForSlices(inputs, extras) {
  const showsById = new Map(inputs.shows.map(s => [s.id, s]));
  const byShow = (list) => {
    const m = new Map();
    for (const r of list) {
      const arr = m.get(r.showId);
      if (arr) arr.push(r); else m.set(r.showId, [r]);
    }
    return m;
  };
  if (!extras || !extras.coverageFloorInputs) throw new Error('indexForSlices: coverageFloorInputs is required');
  return {
    inputs,
    showsById,
    audienceByShowId: byShow(inputs.audience),
    buzzByShowId: byShow(inputs.buzz),
    consensusById: extras.consensusById || {},
    audienceBuzzById: extras.audienceBuzzById || {},
    coverageFloorInputs: extras.coverageFloorInputs,
  };
}

/** One show's slice, or null when the id has no computable row. */
function sliceFor(id, index) {
  const row = index.showsById.get(id);
  // getAllShows() never computes _devOnly rows (inputs.computableShows).
  if (!row || row._devOnly) return null;
  const cfi = index.coverageFloorInputs;
  return {
    sliceVersion: SLICE_VERSION,
    showId: id,
    row,
    reviews: index.inputs.reviewsByShowId.get(id) || [],
    blogReviews: index.inputs.blogReviewsByShowId.get(id) || [],
    audience: index.audienceByShowId.get(id) || [],
    buzz: index.buzzByShowId.get(id) || [],
    consensus: Object.hasOwn(index.consensusById, id) ? index.consensusById[id] : null,
    audienceBuzz: Object.hasOwn(index.audienceBuzzById, id) ? index.audienceBuzzById[id] : null,
    coverage: {
      cov: cfi.covByShowId.get(id) ?? null,
      scorePublicSince: cfi.scorePublicSinceByShowId.get(id) ?? null,
      acked: cfi.coverageAckedShowIds.has(id),
    },
  };
}

/** 16-hex content hash of a slice (key order and undefined fields do not matter). */
function sliceHash(slice) {
  return hash16(stable(slice));
}

/**
 * The coverage-floor inputs computeOneShow needs, rebuilt from one slice (the
 * same three maps buildCoverageFloorInputs returns, holding only this show).
 * COVERAGE_GATE_DISABLED is read here, at render time, like the build-time
 * loaders do, so the kill switch also releases holds on published slices.
 */
function coverageInputsFromSlice(slice, env = process.env) {
  const covByShowId = new Map();
  const scorePublicSinceByShowId = new Map();
  const coverageAckedShowIds = new Set();
  if (coverageGateDisabled(env)) return { covByShowId, scorePublicSinceByShowId, coverageAckedShowIds };
  if (slice.coverage.cov) covByShowId.set(slice.showId, slice.coverage.cov);
  if (slice.coverage.scorePublicSince) scorePublicSinceByShowId.set(slice.showId, slice.coverage.scorePublicSince);
  if (slice.coverage.acked) coverageAckedShowIds.add(slice.showId);
  return { covByShowId, scorePublicSinceByShowId, coverageAckedShowIds };
}

module.exports = { SLICE_VERSION, indexForSlices, sliceFor, sliceHash, coverageInputsFromSlice };
