'use strict';
/**
 * Lint gate (BRO-76): every file in push-core-data/action.yml's CORE_FILES
 * bash array must have a matching entry in the canonical registry
 * (scripts/lib/core-data-merge-registry.js) — 'active' (generically
 * reconciled), 'special' (bespoke-reconciled elsewhere, documented),
 * 'deferred' (known risk, explicitly not yet reconciled, with a reason), or
 * 'single-writer' (no real concurrent-write risk today).
 *
 * This is the check that would have caught diary-shows.json's omission
 * (issue #176) systematically instead of by luck: a NEW name added to
 * CORE_FILES with no matching registry entry is now a loud CI failure
 * instead of a silent "falls to -X ours" gap.
 *
 * Pure (string/array in, data out) per project rule §15 — the filesystem
 * read lives in the colocated test's "REGRESSION: every real CORE_FILES
 * entry..." case (scripts/lib/core-data-registry-coverage.test.mjs), which
 * reads the real action.yml and CORE_DATA_MERGE_REGISTRY directly. That test
 * runs on every push touching scripts/lib/** or push-core-data/action.yml
 * (both are in test.yml's push-path allowlist) — no separate standalone
 * audit CLI script exists or is needed, same pattern reconcile-coverage.js's
 * own "every real .github/workflows/*.yml is clean" test already uses.
 */

// Matches the `CORE_FILES="a b c"` bash line in the "Sync core data files to
// checkout" step. Coarse (literal string match, not real bash parsing) —
// same tradeoff every other lint gate in this codebase makes.
const CORE_FILES_RE = /CORE_FILES="([^"]+)"/;

/**
 * @param {string} actionYmlText raw contents of push-core-data/action.yml
 * @returns {string[]} the CORE_FILES basenames, in file order
 */
function extractCoreFiles(actionYmlText) {
  const m = CORE_FILES_RE.exec(actionYmlText);
  if (!m) return [];
  return m[1].split(/\s+/).filter(Boolean);
}

/**
 * @param {string[]} coreFiles basenames from extractCoreFiles()
 * @param {Array<{file:string,surface:string,status:string}>} registry CORE_DATA_MERGE_REGISTRY
 * @returns {{file:string}[]} CORE_FILES entries with NO matching
 *   private-core-data registry entry at all — the actual gap this gate exists
 *   to catch. (A file registered but with a bad/missing `status` field is a
 *   registry bug, not a coverage gap — deliberately not this function's job.)
 */
function findUnregisteredCoreFiles(coreFiles, registry) {
  const known = new Set(registry.filter((e) => e.surface === 'private-core-data').map((e) => e.file));
  return coreFiles.filter((f) => !known.has(f)).map((file) => ({ file }));
}

module.exports = { extractCoreFiles, findUnregisteredCoreFiles };
