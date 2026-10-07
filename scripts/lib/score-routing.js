/**
 * Score Routing — single source of truth for writing extracted ratings to
 * review-text files.
 *
 * Why this exists
 * ---------------
 * A review-text file has TWO score slots:
 *
 *   - data.originalScore       — the OUTLET'S OWN published rating (e.g. NYT
 *                                 critic gives "3 of 4 stars"). Drives
 *                                 critic-vs-audience separation, P0 score
 *                                 routing, and the public composite.
 *
 *   - data.aggregatorStars     — a third-party AGGREGATOR'S star rating for
 *                                 the same review (e.g. Show Score, LBO,
 *                                 westendtheatre, theatre-reviews). Stored as
 *                                 metadata only — never feeds the composite.
 *
 * The split is enforced by `validate-data.js`:
 *
 *     scoreSource ∈ AGGREGATOR_SCORE_SOURCES && originalScore != null
 *         ⇒ Data Validation FAILS
 *
 * Multiple writers historically violated this invariant by writing
 * `data.originalScore` without checking the file's existing scoreSource.
 * If the file was already tagged as an aggregator (e.g., a wayback recovery
 * runs against an LBO-tagged review), originalScore got contaminated and
 * the test suite went red.
 *
 * Each occurrence was patched script-by-script over the months
 * (5a8cc86e, 9d36edbe, 532606e9, c7006ad2, d46463cee, …) but new sites kept
 * appearing because there was no canonical helper. **This module is that
 * helper.** All scripts that write extracted scores must go through
 * `setExtractedScore()`. Direct `data.originalScore = X` outside this module,
 * `lib/`, fix-* scripts, and migrations is a bug.
 *
 * Invariant
 * ---------
 *
 *   If EITHER the incoming extraction's source OR the file's existing
 *   scoreSource is in AGGREGATOR_SCORE_SOURCES, the value belongs in
 *   `aggregatorStars` — never in `originalScore`.
 *
 * This is the same logic patched into `recover-explicit-ratings.js` and
 * `retry-pending-scores.js` by d46463cee. Centralizing it means future
 * writers can't forget the existing-source half of the check.
 */

const { AGGREGATOR_SCORE_SOURCES } = require('./review-normalization');

/**
 * Decide which slot a freshly-extracted score belongs in, given:
 *   - the source the new extractor reports
 *   - the source the file is already tagged with
 *
 * Returns true if the score should land in `aggregatorStars`, false if it
 * should land in `originalScore`.
 */
function isAggregatorScore(incomingSource, existingScoreSource) {
  return (
    AGGREGATOR_SCORE_SOURCES.has(incomingSource) ||
    AGGREGATOR_SCORE_SOURCES.has(existingScoreSource)
  );
}

/**
 * Write an extracted score to a review-text data object, routing it to
 * `originalScore` or `aggregatorStars` based on whether the incoming or
 * existing source is an aggregator.
 *
 * Mutates `data` in place. Returns metadata about what happened so callers
 * can log it.
 *
 * @param {object} data           The review-text JSON object (mutated).
 * @param {object} extracted      The extractor result.
 * @param {string} extracted.value
 *     Human-readable score string ("4/5 stars", "B+", etc.).
 * @param {number} [extracted.normalizedValue]
 *     0-100 normalized form of the score, if available.
 * @param {string} extracted.source
 *     The source identifier the extractor reports (e.g. 'lbo-css-stars',
 *     'guardian-api', 'json-ld', 'letter-grade').
 * @returns {{ field: 'originalScore' | 'aggregatorStars', wasAggregator: boolean }}
 */
function setExtractedScore(data, { value, normalizedValue, source }) {
  if (value == null || source == null) {
    throw new Error('setExtractedScore: value and source are required');
  }

  const wasAggregator = isAggregatorScore(source, data.scoreSource);

  if (wasAggregator) {
    data.aggregatorStars = value;
    if (normalizedValue != null) {
      data.aggregatorStarsNormalized = normalizedValue;
    }
    // Tag the aggregator slot's source so we know where it came from, but
    // do NOT touch data.scoreSource — that field reflects the file's
    // outlet/critic source, not the metadata extractor.
    data.aggregatorStarsSource = source;
    return { field: 'aggregatorStars', wasAggregator: true };
  }

  data.originalScore = value;
  if (normalizedValue != null) {
    data.originalScoreNormalized = normalizedValue;
  }
  data.originalScoreSource = source;
  return { field: 'originalScore', wasAggregator: false };
}

/**
 * Repair a review-text data object that already violates the invariant
 * (scoreSource is an aggregator AND originalScore is set). Moves the value
 * to `aggregatorStars`, clears `originalScore`, and returns true if any
 * change was made.
 *
 * Use this from rebuilds, validators (--fix mode), and any pipeline that
 * may have inherited contamination from earlier writers.
 */
function repairAggregatorContamination(data) {
  if (
    data.scoreSource &&
    AGGREGATOR_SCORE_SOURCES.has(data.scoreSource) &&
    data.originalScore != null
  ) {
    if (data.aggregatorStars == null) {
      data.aggregatorStars = data.originalScore;
    }
    if (
      data.aggregatorStarsNormalized == null &&
      data.originalScoreNormalized != null
    ) {
      data.aggregatorStarsNormalized = data.originalScoreNormalized;
    }
    data.originalScore = null;
    data.originalScoreNormalized = null;
    if (
      data.originalScoreSource &&
      AGGREGATOR_SCORE_SOURCES.has(data.originalScoreSource)
    ) {
      data.originalScoreSource = null;
    }
    return true;
  }
  return false;
}

module.exports = {
  AGGREGATOR_SCORE_SOURCES,
  isAggregatorScore,
  setExtractedScore,
  repairAggregatorContamination,
};
