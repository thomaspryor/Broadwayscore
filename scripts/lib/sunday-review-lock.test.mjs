import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { alreadyRanToday, etDateString, readMeta } = require('./sunday-review-lock.js');

test('a run earlier today (ET) reads ALREADY_RAN', () => {
  const now = new Date('2026-08-02T14:00:00Z'); // 10am ET
  const meta = { ranAt: '2026-08-02T13:05:00Z' }; // 9:05am ET, same day
  assert.equal(alreadyRanToday(meta, now), true);
});

test('a run from last Sunday reads PENDING (proceed)', () => {
  const now = new Date('2026-08-02T14:00:00Z');
  const meta = { ranAt: '2026-07-26T13:05:00Z' };
  assert.equal(alreadyRanToday(meta, now), false);
});

test('UTC date differs from ET date around midnight — ET calendar day wins', () => {
  // 2026-08-03 00:30 UTC is still 2026-08-02 8:30pm ET.
  const now = new Date('2026-08-03T00:30:00Z');
  const meta = { ranAt: '2026-08-02T13:05:00Z' }; // 9:05am ET same ET-day
  assert.equal(alreadyRanToday(meta, now), true);
});

test('missing meta reads PENDING, not a thrown error', () => {
  assert.doesNotThrow(() => alreadyRanToday(null));
  assert.equal(alreadyRanToday(null), false);
});

test('meta without ranAt reads PENDING', () => {
  assert.equal(alreadyRanToday({}), false);
});

test('malformed ranAt reads PENDING (fail toward proceed, not skip)', () => {
  assert.equal(alreadyRanToday({ ranAt: 'not-a-date' }), false);
});

test('readMeta returns null on missing/corrupt file, never throws', () => {
  assert.doesNotThrow(() => readMeta('/tmp/does-not-exist-sunday-review-lock-507.json'));
  assert.equal(readMeta('/tmp/does-not-exist-sunday-review-lock-507.json'), null);
});

test('etDateString is stable for a fixed instant', () => {
  assert.equal(etDateString(new Date('2026-08-02T13:05:00Z')), '2026-08-02');
});
