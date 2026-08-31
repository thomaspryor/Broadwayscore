#!/usr/bin/env node
/**
 * Pure decision logic for scripts/audit-test-yml-manifest-paths.js (CLAUDE.md
 * §15: the test require()s this, never a copy of the rule).
 *
 * The question: is every test file registered in a unit-test manifest also
 * reachable by test.yml's on.push.paths allow-list? See the CLI's header for
 * why the two lists diverging is so costly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readPushPathsFrom, isCovered } = require('./test-yml-push-paths.js');

// All THREE manifests test.yml actually consumes. The e2e one was missed on the
// first pass and caught in pre-merge review: test.yml:4996 reads it exactly the
// way :3539/:3545 read the other two, so omitting it left the gate green while an
// e2e-unit test registered there but placed outside tests/** would reintroduce
// precisely the bug this gate blocks. All 75 of its entries sit under tests/**
// today, so there was no live gap — but an invisible blind spot in a blocking
// gate is the thing that lets the bug class come back a fifth time.
const MANIFEST_FILES = [
  'tests/unit-test-manifest.txt',
  'tests/unit-test-manifest-tsx.txt',
  'tests/e2e-unit-test-manifest.txt',
];
const WORKFLOW_REL = '.github/workflows/test.yml';

/** Manifest lines are one repo-relative path each; `#` comments and blanks skipped. */
function readManifestEntries(absPath) {
  return fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * @param {string} repoRoot
 * @returns {{test: string, manifest: string}[]} registered tests no push path reaches
 */
function findManifestPathGaps(repoRoot) {
  const pathEntries = readPushPathsFrom(path.join(repoRoot, WORKFLOW_REL));
  if (pathEntries.length === 0) {
    // Fail closed rather than declaring every test uncovered OR every test fine:
    // an empty list means the parse broke, not that the allow-list is empty.
    throw new Error(`parsed 0 push paths from ${WORKFLOW_REL} — the on.push.paths block moved or changed shape`);
  }

  const gaps = [];
  for (const manifest of MANIFEST_FILES) {
    const abs = path.join(repoRoot, manifest);
    if (!fs.existsSync(abs)) throw new Error(`manifest not found: ${manifest}`);
    for (const entry of readManifestEntries(abs)) {
      if (!isCovered(entry, pathEntries)) gaps.push({ test: entry, manifest });
    }
  }
  return gaps;
}

module.exports = { findManifestPathGaps, readManifestEntries, MANIFEST_FILES, WORKFLOW_REL };
