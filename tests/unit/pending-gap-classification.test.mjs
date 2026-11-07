/**
 * Unit tests for scripts/lib/pending-gap-classification.js.
 *
 * Guards the stuck-vs-fresh split in validate-data.js:validateUnscoredReviewTexts.
 * Schmigadoon 2026 Bug #11: pending files sat for weeks without alerting because
 * nothing tested the threshold classification. With 0 stuck files in healthy
 * data the code path is dormant — these tests exercise it directly.
 *
 * Per CLAUDE.md §15: require() the real function — never duplicate its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  classifyPendingGapsByAge,
  DEFAULT_STUCK_PENDING_DAYS,
} = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'pending-gap-classification.js'));

const THRESHOLD = DEFAULT_STUCK_PENDING_DAYS; // 7

// ---- boundary behaviour ----
test('empty array: both cohorts empty', () => {
  const { stuck, fresh } = classifyPendingGapsByAge([]);
  assert.deepEqual(stuck, []);
  assert.deepEqual(fresh, []);
});

test('pure fresh: all entries under or at threshold', () => {
  const gaps = [
    { file: 'a.json', ageDays: 0 },
    { file: 'b.json', ageDays: 3 },
    { file: 'c.json', ageDays: THRESHOLD }, // strict-greater-than: 7 is still fresh
  ];
  const { stuck, fresh } = classifyPendingGapsByAge(gaps, THRESHOLD);
  assert.equal(stuck.length, 0);
  assert.equal(fresh.length, 3);
});

test('pure stuck: all entries strictly above threshold', () => {
  const gaps = [
    { file: 'a.json', ageDays: THRESHOLD + 1 }, // 8
    { file: 'b.json', ageDays: 30 },
    { file: 'c.json', ageDays: 90 },
  ];
  const { stuck, fresh } = classifyPendingGapsByAge(gaps, THRESHOLD);
  assert.equal(stuck.length, 3);
  assert.equal(fresh.length, 0);
});

test('mixed cohort: splits correctly', () => {
  const gaps = [
    { file: 'fresh-1.json', ageDays: 2 },
    { file: 'stuck-1.json', ageDays: 14 },
    { file: 'fresh-2.json', ageDays: 7 }, // exactly threshold → fresh
    { file: 'stuck-2.json', ageDays: 8 }, // threshold + 1 → stuck
  ];
  const { stuck, fresh } = classifyPendingGapsByAge(gaps, THRESHOLD);
  assert.deepEqual(stuck.map((g) => g.file), ['stuck-1.json', 'stuck-2.json']);
  assert.deepEqual(fresh.map((g) => g.file), ['fresh-1.json', 'fresh-2.json']);
});

test('null ageDays: treated as fresh', () => {
  const gaps = [
    { file: 'missing-ts.json', ageDays: null },
    { file: 'also-missing.json' }, // ageDays omitted entirely
    { file: 'stuck.json', ageDays: 30 },
  ];
  const { stuck, fresh } = classifyPendingGapsByAge(gaps, THRESHOLD);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].file, 'stuck.json');
  assert.equal(fresh.length, 2);
});

test('NaN ageDays: treated as fresh (not finite)', () => {
  const gaps = [{ file: 'weird.json', ageDays: NaN }];
  const { stuck, fresh } = classifyPendingGapsByAge(gaps, THRESHOLD);
  assert.equal(stuck.length, 0);
  assert.equal(fresh.length, 1);
});

test('custom threshold: 3 days', () => {
  const gaps = [
    { file: 'a.json', ageDays: 2 },
    { file: 'b.json', ageDays: 4 },
  ];
  const { stuck, fresh } = classifyPendingGapsByAge(gaps, 3);
  assert.deepEqual(stuck.map((g) => g.file), ['b.json']);
  assert.deepEqual(fresh.map((g) => g.file), ['a.json']);
});

// ---- input validation ----
test('rejects non-array gaps', () => {
  assert.throws(() => classifyPendingGapsByAge(null), TypeError);
  assert.throws(() => classifyPendingGapsByAge('not-an-array'), TypeError);
  assert.throws(() => classifyPendingGapsByAge({}), TypeError);
});

test('rejects non-positive threshold', () => {
  assert.throws(() => classifyPendingGapsByAge([], 0), RangeError);
  assert.throws(() => classifyPendingGapsByAge([], -1), RangeError);
  assert.throws(() => classifyPendingGapsByAge([], NaN), RangeError);
});

// ---- preserves record shape ----
test('cohort entries preserve the original gap objects (identity, not clone)', () => {
  const g = { file: 'a.json', ageDays: 30, outlet: 'nyt', critic: 'JG' };
  const { stuck } = classifyPendingGapsByAge([g], THRESHOLD);
  assert.equal(stuck[0], g); // same reference
  assert.equal(stuck[0].outlet, 'nyt');
});
