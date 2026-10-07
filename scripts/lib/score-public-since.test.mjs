// Coverage Verdict S3 (task #905) — score-public-since stamp update logic.
// Run: node --test scripts/lib/score-public-since.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { computeScorePublicSinceUpdates } = createRequire(import.meta.url)('./score-public-since.js');

test('stamps a show the first time cs goes non-null', () => {
  const { stamps, newlyStamped } = computeScorePublicSinceUpdates({}, { 'show-a': 78 }, '2026-08-03T00:00:00.000Z');
  assert.deepStrictEqual(stamps, { 'show-a': '2026-08-03T00:00:00.000Z' });
  assert.deepStrictEqual(newlyStamped, ['show-a']);
});

test('never overwrites an existing stamp (append-only)', () => {
  const prev = { 'show-a': '2026-08-01T00:00:00.000Z' };
  const { stamps, newlyStamped } = computeScorePublicSinceUpdates(prev, { 'show-a': 82 }, '2026-08-03T00:00:00.000Z');
  assert.strictEqual(stamps['show-a'], '2026-08-01T00:00:00.000Z');
  assert.deepStrictEqual(newlyStamped, []);
});

test('a stamped show whose cs later goes null keeps its stamp (no clock reset)', () => {
  const prev = { 'show-a': '2026-08-01T00:00:00.000Z' };
  const { stamps, newlyStamped } = computeScorePublicSinceUpdates(prev, { 'show-a': null }, '2026-08-03T00:00:00.000Z');
  assert.strictEqual(stamps['show-a'], '2026-08-01T00:00:00.000Z');
  assert.deepStrictEqual(newlyStamped, []);
});

test('a never-public show (cs null/undefined) never gets stamped', () => {
  const { stamps, newlyStamped } = computeScorePublicSinceUpdates({}, { 'show-a': null, 'show-b': undefined }, '2026-08-03T00:00:00.000Z');
  assert.deepStrictEqual(stamps, {});
  assert.deepStrictEqual(newlyStamped, []);
});
