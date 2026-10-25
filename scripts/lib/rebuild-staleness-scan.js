'use strict';

/**
 * The read-only scan behind the stale-checkout race guard, shared by
 * scripts/check-rebuild-staleness.js (blocking, with guard escalation) and
 * scripts/check-rebuild-staleness-advisory.js (BRO-3162: report-only, for the
 * workflows that adopted the guard via .github/actions/sync-review-texts-drift).
 *
 * For each drifted show id, walks its review-texts files and asks the SAME
 * functions rebuild-all-reviews.js calls whether a file would be included:
 * isIncludableForRebuild (review-guards.js) AND getBestScore()
 * (rebuild-helpers.js), never a reimplementation, per
 * memory/feedback_includability_predicates_must_be_canonical.md. A show with
 * such a file but zero reviews.json entries was silently dropped.
 *
 * Pure reads: never writes a file, never alerts. Callers decide.
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./list-show-dirs');
const { isIncludableForRebuild } = require('./review-guards');
const { getBestScore, applyScoreRelevantMigrations } = require('./rebuild-helpers');
const { normalizeOutlet } = require('./review-normalization');
const { getSyndicationPrimaries, hasLiveSyndicationPrimary } = require('./syndication-pairs');
const { findMissingScoreableShows } = require('./rebuild-staleness-guard');

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readCandidateShowIds(showsFileArg) {
  if (!showsFileArg || !fs.existsSync(showsFileArg)) return [];
  return fs.readFileSync(showsFileArg, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Would rebuild-all-reviews.js include this specific file? Composes the two
 * real functions it calls — never a bespoke reimplementation. Mirrors
 * rebuild-all-reviews.js's own pre-scoring step: applyScoreRelevantMigrations
 * mutates a working copy in-memory before getBestScore() is asked whether a
 * score exists, so a file whose score is only exposed by that migration
 * (aggregator-source normalization, garbage-text recovery) isn't
 * misclassified as unscoreable here. Mutates a fresh copy, never the file on
 * disk.
 */
function isScoreableFile(data, show, filePath) {
  if (!isIncludableForRebuild(data, show || {}, filePath)) return false;
  const migrated = { ...data };
  applyScoreRelevantMigrations(migrated);
  return getBestScore(migrated) !== null;
}

/**
 * Mirrors the unflagged-secondary dedup in rebuild-all-reviews.js (the
 * runtime syndication shield): a syndicated secondary copy is excluded when a
 * LIVE primary sibling for the same critic exists in the same show directory.
 * Uses getSyndicationPrimaries (per-critic pairs AND publishing groups, e.g.
 * Observer/Guardian, BRO-6046) and hasLiveSyndicationPrimary, the same
 * fallback the rebuild uses, so the scan cannot drift from it. The primary
 * filename match is anchored (`<primary>--<slug>.json`), so a file is never
 * compared against itself. A primary that will not itself be scored releases
 * its secondary, as the rebuild's syndicationShieldDecision does.
 */
function isUnflaggedSyndicationSecondary(data, currentFile, allFiles, showDir, show) {
  const criticName = (data.criticName || '').toLowerCase().trim();
  const outletId = normalizeOutlet(data.outletId || data.outlet || '');
  const primaries = getSyndicationPrimaries(criticName, outletId);
  if (!primaries.length) return false;
  return hasLiveSyndicationPrimary(showDir, primaries, criticName,
    { fileNames: allFiles.filter((f) => f !== currentFile), extraCheck: (p, fp) => isScoreableFile(p, show, fp) });
}

/**
 * @param {string[]} candidateShowIds - show ids that drifted during the job
 * @param {string} dataDir - the repo's data/ directory
 * @returns {{ ok: false } | { ok: true, scoreableShowIds: string[], missing: string[] }}
 *   ok:false means data/reviews.json could not be read (scope unknown).
 */
function scanDriftedShows(candidateShowIds, dataDir) {
  const reviewTextsDir = path.join(dataDir, 'review-texts');
  const showsDoc = loadJSON(path.join(dataDir, 'shows.json'));
  const shows = (showsDoc && (showsDoc.shows || showsDoc)) || [];
  const showsById = new Map((Array.isArray(shows) ? shows : []).map((s) => [s.id, s]));

  const reviewsDoc = loadJSON(path.join(dataDir, 'reviews.json'));
  if (!reviewsDoc || !Array.isArray(reviewsDoc.reviews)) return { ok: false };
  const reviewsShowIds = reviewsDoc.reviews.map((r) => r.showId);

  const knownShowDirs = new Set(listShowDirs(reviewTextsDir, { silent: true }));
  const scoreableShowIds = [];
  for (const showId of candidateShowIds) {
    // `_pending` / `_superseded-misattributed` hold moved or deleted review files, not
    // shows: a plan delete lands files there, and they never reach reviews.json by design.
    if (showId.startsWith('_')) continue;
    if (!knownShowDirs.has(showId)) continue;
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    const show = showsById.get(showId);
    const isScoreable = files.some((file) => {
      const data = loadJSON(path.join(showDir, file));
      if (!data) return false;
      if (!isScoreableFile(data, show, path.join(showDir, file))) return false;
      if (isUnflaggedSyndicationSecondary(data, file, files, showDir, show)) return false;
      return true;
    });
    if (isScoreable) scoreableShowIds.push(showId);
  }
  return { ok: true, scoreableShowIds, missing: findMissingScoreableShows(scoreableShowIds, reviewsShowIds) };
}

module.exports = {
  loadJSON,
  readCandidateShowIds,
  isScoreableFile,
  isUnflaggedSyndicationSecondary,
  scanDriftedShows,
};
