'use strict';
// shows-json-path.js (BRO-8107) — where data/shows.json is, read at CALL time.
//
// SHOWS_JSON_PATH (an env var, so it also reaches processes a test spawns)
// points every shared guard at a fixture. Without it the guards read the
// repo's live data/shows.json, and any test that reaches them (safeWriteReview,
// isScoreable, createOrMergeReviewFile) becomes a live-data test that
// land.yml's live-data-lane check refuses (BRO-8065/8079/8092).
//
// Callers cache their parsed lookups keyed by the returned path, so setting or
// clearing the variable mid-process takes effect on the next call.
const path = require('path');
const fs = require('fs');

const REPO_SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

/**
 * @param {{homeFallback?: boolean}} [opts] homeFallback: when the repo copy is
 *   absent, use ~/broadway-scorecard-data/shows.json (gap tooling run outside a checkout).
 */
function showsJsonPath({ homeFallback = false } = {}) {
  // Absolute, so require() (relative to its caller) and fs reads (relative to cwd) agree.
  if (process.env.SHOWS_JSON_PATH) return path.resolve(process.env.SHOWS_JSON_PATH);
  if (homeFallback && !fs.existsSync(REPO_SHOWS_PATH)) {
    return path.join(require('os').homedir(), 'broadway-scorecard-data', 'shows.json');
  }
  return REPO_SHOWS_PATH;
}

/** Parse a shows.json at `p` into an array (top-level array or {shows}). Throws on read/parse errors. */
function readShowsList(p = showsJsonPath()) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.shows || []);
}

// useShowsFixture (the test helper that WRITES a temp fixture) lives in
// shows-json-fixture.js, so this reader stays write-free in the require graph of
// safe-form audit scripts (safe-form-allowlist.test.mjs).

module.exports = { showsJsonPath, readShowsList, REPO_SHOWS_PATH };
