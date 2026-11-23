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
  if (process.env.SHOWS_JSON_PATH) return process.env.SHOWS_JSON_PATH;
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

/**
 * Test helper: write `shows` to a temp shows.json and point SHOWS_JSON_PATH at
 * it (in this process and every process it spawns). Returns a restore function
 * that puts the previous value back and deletes the file.
 */
function useShowsFixture(shows) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-fixture-'));
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify({ shows: shows || [] }));
  const prev = process.env.SHOWS_JSON_PATH;
  process.env.SHOWS_JSON_PATH = file;
  return function restore() {
    if (prev === undefined) delete process.env.SHOWS_JSON_PATH; else process.env.SHOWS_JSON_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

module.exports = { showsJsonPath, readShowsList, useShowsFixture, REPO_SHOWS_PATH };
