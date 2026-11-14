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

// Sources that read the outlet's own rating element (page structure), not the
// review prose. A clear whose reason is "no star in the text" or "outlet has
// no ratings" says nothing about them: Time Out's SVG stars and London
// Theatre's page-data stars (BRO-3139) never appear in fullText, so the clear
// and the re-extracted star sat side by side on 136 files (BRO-3171).
// review-guards' STRUCTURAL_STAR_SOURCES is the canonical list (its not-a-review
// exception doesn't cover London Theatre's page-data star, so it's added here).
// Lazy require: review-guards is heavy.
let _structuralStarSources = null;
function structuralStarSources() {
  if (!_structuralStarSources) {
    _structuralStarSources = new Set([
      ...require('./review-guards').STRUCTURAL_STAR_SOURCES,
      'londontheatre-page-json',
    ]);
  }
  return _structuralStarSources;
}
// Clear reasons a page-structure star disproves. Not aggregator-in-p0-slot or
// wrong-show clears: those are about WHOSE star it is, which structure can't settle.
const RETIRABLE_CLEAR_REASON_RE = /^(extraction-no-evidence|outlet-publishes-no-critic-rating|london-theatre)/i;

/**
 * Retire an originalScoreCleared breadcrumb that a later star supersedes.
 * Records what superseded it; review-write-guard's CLEAR_BREADCRUMBS honours
 * originalScoreClearSupersededBy so a rebase restore can't resurrect the clear.
 * @param {object} data   review-text record (mutated)
 * @param {string} supersededBy  the source (or evidence) that superseded it
 * @returns {boolean} true when it retired a breadcrumb
 */
function retireSupersededScoreClear(data, supersededBy) {
  if (!data || data.originalScoreCleared !== true || !supersededBy) return false;
  data.originalScoreClearSupersededBy = supersededBy;
  if (data.originalScoreClearedReason) data.originalScoreClearSupersededReason = data.originalScoreClearedReason;
  data.originalScoreClearSupersededAt = new Date().toISOString();
  delete data.originalScoreCleared;
  delete data.originalScoreClearedReason;
  return true;
}

/** True when `source` is a page-structure star that disproves this file's clear. */
function isScoreClearSupersededBy(data, source) {
  return !!(data && data.originalScoreCleared === true
    && structuralStarSources().has(source)
    && RETIRABLE_CLEAR_REASON_RE.test(String(data.originalScoreClearedReason || '')));
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
 * @returns {{ field: 'originalScore' | 'aggregatorStars' | 'blocked', wasAggregator: boolean, blocked?: boolean }}
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

  // A deliberate clear survives later extraction attempts. Only a structural
  // star that disproves the clear may retire it (BRO-3171). Keep aggregator
  // metadata above independent of the outlet rating's clear (BRO-5296).
  if (data.originalScoreCleared === true && !isScoreClearSupersededBy(data, source)) {
    // Existing callers use wasAggregator to skip their scoreSource overwrite.
    return { field: 'blocked', wasAggregator: true, blocked: true };
  }

  data.originalScore = value;
  if (normalizedValue != null) {
    data.originalScoreNormalized = normalizedValue;
  }
  data.originalScoreSource = source;
  if (isScoreClearSupersededBy(data, source)) retireSupersededScoreClear(data, source);
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
  structuralStarSources,
  retireSupersededScoreClear,
  isScoreClearSupersededBy,
};
