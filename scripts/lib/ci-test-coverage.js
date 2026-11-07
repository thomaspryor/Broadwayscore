'use strict';
// scripts/lib/ci-test-coverage.js — the pure "does CI actually execute this
// test file?" rule behind scripts/audit-orphan-tests.js (BRO-2778).
//
// WHY THIS EXISTS
//   audit-orphan-tests.js used to answer by BARE FILENAME: it collected every
//   `*.test.mjs` basename found in any workflow `run:` text or manifest line,
//   then asked "is this file's basename in that set?". A basename is not a
//   path. scripts/cast-backfill-year-validation.test.mjs read as covered because
//   tests/unit/cast-backfill-year-validation.test.mjs (a different file) is in
//   the unit manifest, and scripts/ingest-manual-review.test.mjs the same way,
//   so both ran in zero CI jobs while the audit printed "All registered".
//
// THE RULE: a test file (repo-relative path) is covered only if
//   1. that exact path is a line of a manifest test.yml feeds to node --test, or
//   2. a glob written in a workflow `run:` step (e.g. scripts/lib/*.test.mjs)
//      matches that exact path, or
//   3. that exact path is named in a workflow `run:` step's command text
//      (shell comments stripped; on.push.paths, name:, env:, with: never count,
//      because the caller passes only extracted run: text).
// Everything else is an orphan, however many workflow lines mention its name.

const { isInvokedIn } = require('./bash-integration-test-list.js');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Path tokens containing a `*` that end in a test-file suffix, as written in
// run: text (quotes and `./` stripped). Only the forms this repo uses:
// `scripts/lib/*.test.mjs` today.
function runTextGlobs(runText) {
  const out = new Set();
  for (const m of runText.matchAll(/[A-Za-z0-9_.\/*-]*\*[A-Za-z0-9_.\/*-]*\.test\.(?:mjs|cjs|js|ts|sh)\b/g)) {
    out.add(m[0].replace(/^\.\//, ''));
  }
  return [...out];
}

function globToRegex(glob) {
  // `*` never crosses a directory: matches bash's (non-globstar) expansion.
  return new RegExp(`^${glob.split('*').map(escapeRe).join('[^/]*')}$`);
}

/**
 * Is relPath named as a whole path in runText? Boundaries on both sides, so
 * tests/x.test.mjs is not satisfied by scripts/tests/x.test.mjs and
 * foo.test.mjs is not satisfied by foo.test.mjs.bak. An optional `./` prefix
 * is accepted.
 */
function runTextNamesPath(runText, relPath) {
  return new RegExp(`(?:^|[^A-Za-z0-9_./-])(?:\\./)?${escapeRe(relPath)}(?![A-Za-z0-9_./-])`, 'm').test(runText);
}

/**
 * @param {string} relPath repo-relative test path, e.g. scripts/foo.test.mjs
 * @param {{manifestEntries: Set<string>, runText: string}} ci
 *   manifestEntries: exact repo-relative lines of the node --test manifests
 *   runText: executable text of every workflow run: step (comments stripped)
 * @returns {false | 'manifest' | 'glob' | 'run-step'}
 */
function ciCoverageOf(relPath, { manifestEntries, runText }) {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1);
  // A *.test.sh runs only via a literal `bash <path>` step; a manifest or a
  // node-test glob can never execute it (BRO-2751), so defer to the shared
  // shell-invocation rule.
  if (ext === 'sh') return isInvokedIn(runText, relPath, 'sh') ? 'run-step' : false;
  if (manifestEntries.has(relPath)) return 'manifest';
  if (runTextGlobs(runText).some((g) => globToRegex(g).test(relPath))) return 'glob';
  if (runTextNamesPath(runText, relPath)) return 'run-step';
  return false;
}

module.exports = { ciCoverageOf, runTextGlobs, runTextNamesPath, globToRegex };
