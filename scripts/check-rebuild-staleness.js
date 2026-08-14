#!/usr/bin/env node
/**
 * check-rebuild-staleness.js — post-rebuild guard for the stale-checkout race
 * (a review-texts push landing between rebuild-reviews.yml's checkout step
 * and its "Rebuild reviews.json" step exits 0 with an incomplete
 * reviews.json — see scripts/lib/rebuild-staleness-guard.js).
 *
 * Scope: ONLY the show ids the workflow determined drifted during this job
 * (git diff between the checkout-time SHA and the pre-rebuild SHA), not the
 * full ~2,800-show corpus — see rebuild-reviews.yml for how that list is
 * produced. For each drifted show, walks its review-texts files and asks the
 * SAME functions rebuild-all-reviews.js actually calls whether the file
 * would be included: isIncludableForRebuild (review-guards.js) AND
 * getBestScore() (rebuild-helpers.js) — never a reimplementation, per
 * memory/feedback_includability_predicates_must_be_canonical.md. If a show
 * has a file that passes both but reviews.json has zero entries for that
 * show, the rebuild silently dropped it — fail the job loudly.
 *
 * Known residual gap: rebuild-all-reviews.js also skips an unflagged
 * syndication SECONDARY when an unflagged primary sibling already exists for
 * the same critic (KNOWN_SYNDICATION_PAIRS, scripts/lib/syndication-pairs.js)
 * — checked below via isSecondaryOutlet() so a same-show primary+secondary
 * pair doesn't false-positive.
 *
 * Usage: node scripts/check-rebuild-staleness.js --shows-file=<path>
 *   <path> is a newline-delimited list of candidate show ids. Missing/empty
 *   file = no drift this run = fast no-op exit 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { getBestScore } = require('./lib/rebuild-helpers');
const { normalizeOutlet } = require('./lib/review-normalization');
const { isSecondaryOutlet } = require('./lib/syndication-pairs');
const { findMissingScoreableShows } = require('./lib/rebuild-staleness-guard');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');

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
 * real functions it calls — never a bespoke reimplementation.
 */
function isScoreableFile(data, show, filePath) {
  if (!isIncludableForRebuild(data, show || {}, filePath)) return false;
  return getBestScore(data) !== null;
}

/**
 * Mirrors the unflagged-secondary dedup in rebuild-all-reviews.js: a
 * syndicated secondary copy is excluded when an unflagged primary sibling
 * for the same critic already exists in the same show directory.
 */
function isUnflaggedSyndicationSecondary(data, allFiles, showDir) {
  const criticName = (data.criticName || '').toLowerCase().trim();
  const outletId = normalizeOutlet(data.outletId || data.outlet || '');
  if (!isSecondaryOutlet(criticName, outletId)) return false;
  const criticSlug = criticName.replace(/\s+/g, '-');
  return allFiles.some((f) => {
    if (!f.includes(criticSlug)) return false;
    const full = path.join(showDir, f);
    const pData = loadJSON(full);
    if (!pData) return false;
    return !pData.wrongProduction && !pData.wrongShow;
  });
}

function main() {
  const showsFileArg = (process.argv.find((a) => a.startsWith('--shows-file=')) || '')
    .replace('--shows-file=', '') || null;
  const candidateShowIds = readCandidateShowIds(showsFileArg);
  if (candidateShowIds.length === 0) {
    console.log('[check-rebuild-staleness] no drifted shows this run — nothing to verify.');
    return;
  }

  const showsDoc = loadJSON(SHOWS_FILE);
  const shows = (showsDoc && (showsDoc.shows || showsDoc)) || [];
  const showsById = new Map(shows.map((s) => [s.id, s]));

  const reviewsDoc = loadJSON(REVIEWS_FILE);
  if (!reviewsDoc || !Array.isArray(reviewsDoc.reviews)) {
    console.error('::error::[check-rebuild-staleness] could not read data/reviews.json — aborting');
    process.exit(1);
  }
  const reviewsShowIds = reviewsDoc.reviews.map((r) => r.showId);

  const knownShowDirs = new Set(listShowDirs(REVIEW_TEXTS_DIR, { silent: true }));
  const scoreableShowIds = [];

  for (const showId of candidateShowIds) {
    if (!knownShowDirs.has(showId)) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
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
      if (isUnflaggedSyndicationSecondary(data, files, showDir)) return false;
      return true;
    });
    if (isScoreable) scoreableShowIds.push(showId);
  }

  const missing = findMissingScoreableShows(scoreableShowIds, reviewsShowIds);
  if (missing.length > 0) {
    console.error(
      `::error::[check-rebuild-staleness] ${missing.length} show(s) had scoreable review-text ` +
      `files (drifted in during this job) but ZERO reviews.json entries after rebuild — ` +
      `stale-checkout race, not a legitimate exclusion. Shows: ${missing.join(', ')}`,
    );
    process.exit(1);
  }
  console.log(
    `[check-rebuild-staleness] verified ${candidateShowIds.length} drifted show(s), ` +
    `${scoreableShowIds.length} scoreable — all present in reviews.json.`,
  );
}

main();
