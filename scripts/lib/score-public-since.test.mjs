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

test('never stamps a show before it opens (wrong-production blip, School Pictures 2026)', () => {
  const { stamps, newlyStamped } = computeScorePublicSinceUpdates({}, { 'show-a': 84 }, '2026-10-06T00:25:31.892Z', { 'show-a': '2026-10-18' });
  assert.deepStrictEqual(stamps, {});
  assert.deepStrictEqual(newlyStamped, []);
});

test('stamps within the 2-day pre-opening grace and after opening', () => {
  const open = { 'show-a': '2026-10-18', 'show-b': '2026-10-18' };
  const r = computeScorePublicSinceUpdates({}, { 'show-a': 84, 'show-b': 80 }, '2026-10-16T12:00:00.000Z', open);
  assert.deepStrictEqual(r.newlyStamped.sort(), ['show-a', 'show-b']);
});

test('prunes an existing pre-opening stamp, keeps a genuine one', () => {
  const prev = { 'show-a': '2026-10-06T00:25:31.892Z', 'show-b': '2026-10-19T00:00:00.000Z' };
  const open = { 'show-a': '2026-10-18', 'show-b': '2026-10-18' };
  const r = computeScorePublicSinceUpdates(prev, {}, '2026-10-20T00:00:00.000Z', open);
  assert.deepStrictEqual(r.pruned, ['show-a']);
  assert.deepStrictEqual(r.stamps, { 'show-b': '2026-10-19T00:00:00.000Z' });
});

test('a pruned pre-opening stamp is re-stamped once cs is public after opening', () => {
  const r = computeScorePublicSinceUpdates({ a: '2026-10-06T00:00:00.000Z' }, { a: 80 }, '2026-10-20T00:00:00.000Z', { a: '2026-10-18' });
  assert.deepStrictEqual(r.pruned, ['a']);
  assert.deepStrictEqual(r.stamps, { a: '2026-10-20T00:00:00.000Z' });
});

test('missing or unparseable openingDate fails open (stamp kept)', () => {
  const prev = { a: '2026-10-06T00:00:00.000Z', b: '2026-10-06T00:00:00.000Z' };
  const r = computeScorePublicSinceUpdates(prev, {}, '2026-10-20T00:00:00.000Z', { b: 'TBA' });
  assert.deepStrictEqual(r.pruned, []);
});

test('grace boundary: exactly 2 days before opening is allowed, 1ms earlier is not', () => {
  const open = { a: '2026-10-18' };
  assert.deepStrictEqual(computeScorePublicSinceUpdates({}, { a: 1 }, '2026-10-16T00:00:00.000Z', open).newlyStamped, ['a']);
  assert.deepStrictEqual(computeScorePublicSinceUpdates({}, { a: 1 }, '2026-10-15T23:59:59.999Z', open).newlyStamped, []);
});

test('with no opening date, the first preview is the reference (Christmas Carol Goes Wrong 2026)', () => {
  const { stampReferenceDate, isPlausibleStamp } = createRequire(import.meta.url)('./score-public-since.js');
  assert.equal(stampReferenceDate({ openingDate: '2026-12-01', previewsStartDate: '2026-11-01' }), '2026-12-01');
  assert.equal(stampReferenceDate({ openingDate: null, previewsStartDate: '2026-12-18' }), '2026-12-18');
  assert.equal(stampReferenceDate({}), null);
  // Stamped in October from another production's reviews, previews in December: dropped.
  assert.equal(isPlausibleStamp('2026-10-08T14:47:17Z', stampReferenceDate({ previewsStartDate: '2026-12-18' })), false);
  // Within the grace period of the first preview: kept.
  assert.equal(isPlausibleStamp('2026-12-17T00:00:00Z', stampReferenceDate({ previewsStartDate: '2026-12-18' })), true);
  // No dates at all: nothing to check against, kept.
  assert.equal(isPlausibleStamp('2026-10-08T14:47:17Z', stampReferenceDate({})), true);
});
