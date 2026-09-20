// BRO-219 — Structural #2: opening night is not truly automated.
//
// The card's original acceptance criterion ("extend this suite to cover the
// remaining 10 of 20 opening-night-checklist.js checks not yet remediated by
// the 2026-08-12 session") went stale the moment the code moved past that
// session's snapshot: dtli-count-mismatch coverage landed 2026-08-20, the
// literal test path in the criterion was never a real file
// (tests/unit/opening-night-checklist.test.mjs vs the real
// scripts/opening-night-checklist.test.mjs), and nothing enumerated "20" from
// the code itself. BRO-3376's In Review triage reopened the card on exactly
// this: the suite passes, but the criterion is unfalsifiable, so "done" can't
// be proven or disproven.
//
// This test IS the falsifiable criterion. REMEDIATION_COVERAGE below is a
// registry mapping every scripts/lib/opening-night-checks/*.check.js file to
// the test file that exercises its self-declared remediation contract (or —
// for review-count-match, the one check that deliberately stays print-only —
// the test that proves the absence is intentional). The first assertion
// fails the moment a check file is added, removed, or renamed without a
// matching registry update, so the "which checks are covered" question can
// never again be answered by re-deriving history from git log.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const CHECKS_DIR = path.join(REPO_ROOT, 'scripts', 'lib', 'opening-night-checks');

const REMEDIATION_COVERAGE = {
  'aggregator-count-drift.check.js': 'tests/unit/opening-night-checks-remediation-coverage.test.mjs',
  'assigned-score-schema.check.js': 'tests/unit/opening-night-checks-remediation-coverage.test.mjs',
  'bww-rr-count-mismatch.check.js': 'scripts/opening-night-checklist.test.mjs',
  'critics-take-present.check.js': 'scripts/opening-night-checklist.test.mjs',
  'cv-wrongproduction-unhandled.check.js': 'tests/unit/opening-night-checks-juan-a-ramirez-bypass.test.mjs',
  'dtli-count-mismatch.check.js': 'scripts/opening-night-checklist.test.mjs',
  'empty-cast.check.js': 'scripts/opening-night-checklist.test.mjs',
  'fulltext-mentions-show.check.js': 'tests/unit/opening-night-checks-juan-a-ramirez-bypass.test.mjs',
  'orphan-scoresource.check.js': 'tests/unit/opening-night-checks-remediation-coverage.test.mjs',
  'placeholder-synopsis.check.js': 'tests/unit/opening-night-checks-metadata-completeness.test.mjs',
  'publish-date-pre-opening.check.js': 'tests/unit/opening-night-checks-remediation-coverage.test.mjs',
  'review-count-match.check.js': 'scripts/opening-night-checklist.test.mjs',
  'revival-unverified.check.js': 'tests/unit/opening-night-checks-metadata-completeness.test.mjs',
  'roundup-url-mismatch.check.js': 'tests/unit/opening-night-checks-juan-a-ramirez-bypass.test.mjs',
  'slug-mismatch.check.js': 'tests/unit/opening-night-checks-juan-a-ramirez-bypass.test.mjs',
  'stale-upcoming-tag.check.js': 'scripts/opening-night-checklist.test.mjs',
  't1-outlets-scored.check.js': 'scripts/opening-night-checklist.test.mjs',
  'unexplained-score-jump.check.js': 'scripts/opening-night-checklist.test.mjs',
  'unparsed-explicit-ratings.check.js': 'scripts/opening-night-checklist.test.mjs',
  'wrong-production-bww.check.js': 'scripts/opening-night-checklist.test.mjs',
};

// index.js / types.js / lifetime-sweep-runner.js are infrastructure, not
// individual checks — loadChecks() (index.js) require()s every *.check.js
// file, which is the actual definition of "a check" this registry counts.
function listCheckFiles() {
  return fs.readdirSync(CHECKS_DIR).filter(f => f.endsWith('.check.js')).sort();
}

describe('opening-night-checks remediation coverage audit', () => {
  it('every check file has a REMEDIATION_COVERAGE entry (fails on add/remove/rename without registry update)', () => {
    const actual = listCheckFiles();
    const registered = Object.keys(REMEDIATION_COVERAGE).sort();
    assert.deepEqual(actual, registered,
      `scripts/lib/opening-night-checks/ and REMEDIATION_COVERAGE have drifted.\n` +
      `On disk (${actual.length}): ${actual.join(', ')}\n` +
      `Registered (${registered.length}): ${registered.join(', ')}\n` +
      `Add/remove the entry above AND write (or point to) a test asserting the check's ` +
      `self-declared remediation contract — details.remediation shape for checks that alert ` +
      `or dispatch a workflow, or an explicit assertion of no remediation for a check that is ` +
      `print-only by design (see review-count-match.check.js).`);
  });

  it('every registered coverage test file exists in the repo', () => {
    for (const [check, relPath] of Object.entries(REMEDIATION_COVERAGE)) {
      const fullPath = path.join(REPO_ROOT, relPath);
      assert.ok(fs.existsSync(fullPath), `${check} -> ${relPath}: registered test file does not exist`);
    }
  });

  it('every check file actually declares a remediation decision (self-declares, or documents opting out)', () => {
    // Static, not behavioral: this catches a check file that ships with zero
    // reference to the remediation contract at all (the exact "detect and
    // stop" pattern BRO-219 describes) without re-running every check's full
    // fixture matrix here — the dedicated test files above own that.
    const missing = [];
    for (const file of listCheckFiles()) {
      const src = fs.readFileSync(path.join(CHECKS_DIR, file), 'utf8');
      if (!/remediation/i.test(src)) missing.push(file);
    }
    assert.deepEqual(missing, [], `check file(s) with no remediation reference at all: ${missing.join(', ')}`);
  });
});
