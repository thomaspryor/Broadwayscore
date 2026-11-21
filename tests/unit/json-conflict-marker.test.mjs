import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// BRO-913: "Conflict markers in JSON files break entire pipeline silently."
// A bad rebase left `<<<<<<< HEAD` markers in review-text JSON files;
// JSON.parse threw, the caller caught it and skipped the file, and reviews
// silently disappeared for hours with no error anywhere. This test exercises
// the real production functions end-to-end (CLAUDE.md §15 — require() the
// real code, never re-copy the logic) to prove:
//   1. a conflict-marker / unparseable file is caught with its file path
//      (acceptance criteria #1/#2), and
//   2. valid review-text files are unaffected (acceptance criteria #3).

const require = createRequire(import.meta.url);
const { validateReviewFile } = require('../../scripts/validate-review-texts.js');
const { findConflictMarkers, hasConflictMarkers } = require('../../scripts/lib/conflict-markers.js');
const { shouldBlockReviewTextsGate, CATASTROPHIC_CHECKS, HEALABLE_CHECKS } = require('../../scripts/lib/review-texts-gate.js');

function makeTmpShowDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-conflict-marker-test-'));
  return dir;
}

// The actual corruption shape from the 2026-04-16 incident: a bad rebase
// merge left the show's real content sandwiched between conflict markers.
const CONFLICTED_REVIEW = [
  '{',
  '<<<<<<< HEAD',
  '  "showId": "fear-of-13",',
  '  "outletId": "chicagotribune",',
  '  "criticName": "Chris Jones",',
  '=======',
  '  "showId": "fear-of-13",',
  '  "outletId": "chicagotribune",',
  '  "criticName": "Chris Jones (updated)",',
  '>>>>>>> a1b2c3d (auto-commit)',
  '  "url": "https://example.com/review"',
  '}',
  '',
].join('\n');

const VALID_REVIEW = JSON.stringify({
  showId: 'fear-of-13',
  outletId: 'chicagotribune',
  criticName: 'Chris Jones',
  url: 'https://example.com/review',
  fullText: 'A review of the show.',
});

test('validateReviewFile reports json_parse with the file path for a conflict-marker file', () => {
  const dir = makeTmpShowDir();
  try {
    const filePath = path.join(dir, 'chicagotribune--chris-jones.json');
    fs.writeFileSync(filePath, CONFLICTED_REVIEW);

    const validOutlets = new Set(['chicagotribune']);
    const result = validateReviewFile(filePath, validOutlets, new Map());

    assert.equal(result.skipped, undefined, 'a corrupt file must not be silently skipped');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].check, 'json_parse');
    assert.ok(result.errors[0].file, 'error must carry a file path');
    assert.ok(
      result.errors[0].file.includes('chicagotribune--chris-jones.json'),
      `expected file path to name the broken file, got: ${result.errors[0].file}`
    );
    assert.match(result.errors[0].message, /Failed to parse JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateReviewFile passes a valid review-text file with no errors', () => {
  const dir = makeTmpShowDir();
  try {
    const filePath = path.join(dir, 'chicagotribune--chris-jones.json');
    fs.writeFileSync(filePath, VALID_REVIEW);

    const validOutlets = new Set(['chicagotribune']);
    const result = validateReviewFile(filePath, validOutlets, new Map());

    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conflict-markers.js flags the same corrupted content validateReviewFile rejects', () => {
  assert.equal(hasConflictMarkers(CONFLICTED_REVIEW), true);
  const hits = findConflictMarkers(CONFLICTED_REVIEW);
  assert.deepEqual(hits.map(h => h.line), [2, 10]);
  assert.equal(hasConflictMarkers(VALID_REVIEW), false);
});

test('json_parse is a zero-tolerance (catastrophic) check — the --gate CI build fails fast on it', () => {
  assert.ok(CATASTROPHIC_CHECKS.has('json_parse'));
  assert.ok(!HEALABLE_CHECKS.has('json_parse'));

  // A single conflict-marker file among an otherwise-clean corpus must still
  // block the trunk — this is the "silently excluded for hours" failure mode:
  // one corrupt file should never hide inside a floor meant for auto-healable
  // duplicate churn.
  const blocked = shouldBlockReviewTextsGate({ catastrophicErrors: 1, healableErrors: 0, floor: 10 });
  assert.equal(blocked, true);
});

test('a clean corpus of valid review-text files does not block the --gate CI build', () => {
  const blocked = shouldBlockReviewTextsGate({ catastrophicErrors: 0, healableErrors: 0, floor: 10 });
  assert.equal(blocked, false);
});
