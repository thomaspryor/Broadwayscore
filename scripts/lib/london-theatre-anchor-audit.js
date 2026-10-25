'use strict';

const { LONDON_THEATRE_PAGE_SOURCE } = require('./score-extractors');
const { VERIFIED_SOURCE } = require('./verified-original-score');
const { detectBandFromReviewFile } = require('./star-reliability');

const bounds = (band) => band && Number.isFinite(band.floor) && Number.isFinite(band.ceiling)
  && band.floor <= band.ceiling ? { floor: band.floor, ceiling: band.ceiling } : null;

/**
 * BRO-4991: audit the writer's anchored-v6 output, including null/cleared stars.
 * An anchored stamp is not proof that the critic printed the relayed rating.
 * Use only a verified originalScore, isolated from the detector's relay fields.
 * Pure and read-only: these worklists do not flag files or spend scoring credits.
 */
function auditLondonTheatreAnchor(data, file) {
  if (data.outletId !== 'london-theatre' || data.scoreSource !== 'anchored-v6') return null;
  const row = {
    file,
    originalScore: data.originalScore ?? null,
    originalScoreSource: data.originalScoreSource ?? null,
    anchoredBand: bounds(data.llmScore?.band),
    score: Number.isFinite(data.llmScore?.score) ? data.llmScore.score : null,
    criticBand: null,
  };
  const verified = data.originalScoreSource === LONDON_THEATRE_PAGE_SOURCE
    || data.originalScoreSource === VERIFIED_SOURCE;
  const detected = verified && data.originalScoreCleared !== true
    && detectBandFromReviewFile({
      outletId: data.outletId,
      originalScore: data.originalScore,
      originalScoreSource: data.originalScoreSource,
      scoreSource: data.originalScoreSource,
    });
  if (!detected || detected.kind !== 'star' || !detected.highReliability) {
    return { ...row, status: 'verify-rating', reason: 'No active verified critic star; do not infer it from the relay or prior band.' };
  }
  row.criticBand = bounds(detected.band);
  if (!row.anchoredBand || row.anchoredBand.floor !== row.criticBand.floor
      || row.anchoredBand.ceiling !== row.criticBand.ceiling) {
    return { ...row, status: 'reanchor', reason: 'Stored anchor band disagrees with the verified critic star.' };
  }
  if (row.score === null || row.score < row.criticBand.floor || row.score > row.criticBand.ceiling) {
    return { ...row, status: 'reanchor', reason: 'Stored score is missing or outside the verified critic star band.' };
  }
  return { ...row, status: 'confirmed' };
}

function summarizeLondonTheatreAnchors(rows) {
  const ordered = [...rows].sort((a, b) => a.file.localeCompare(b.file));
  return {
    total: ordered.length,
    confirmed: ordered.filter((row) => row.status === 'confirmed'),
    reanchorQueue: ordered.filter((row) => row.status === 'reanchor'),
    ratingVerificationQueue: ordered.filter((row) => row.status === 'verify-rating'),
  };
}

module.exports = { auditLondonTheatreAnchor, summarizeLondonTheatreAnchors };
