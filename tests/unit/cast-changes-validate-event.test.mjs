import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// Require the REAL validateEvent (now exported + guarded by require.main so the
// import doesn't launch a scrape). Tests the date normalization/validation that
// defends dedup against mixed precision (YYYY-MM vs YYYY-MM-DD) and impossible
// calendar dates that new Date() silently rolls forward.
const require = createRequire(import.meta.url);
const { validateEvent } = require('../../scripts/scrape-cast-changes.js');

test('validateEvent accepts a full ISO date', () => {
  const e = { type: 'closure', name: 'X', date: '2026-06-28' };
  assert.equal(validateEvent(e), true);
  assert.equal(e.date, '2026-06-28');
});

test('validateEvent normalizes month-only YYYY-MM to the first of the month', () => {
  const e = { type: 'closure', name: 'X', date: '2026-06' };
  assert.equal(validateEvent(e), true);
  assert.equal(e.date, '2026-06-01', 'month-only coerced for precision-consistent dedup');
});

test('validateEvent rejects impossible calendar dates (would silently roll forward)', () => {
  assert.equal(validateEvent({ type: 'closure', name: 'X', date: '2026-02-31' }), false);
  assert.equal(validateEvent({ type: 'closure', name: 'X', date: '2026-13-01' }), false);
  assert.equal(validateEvent({ type: 'closure', name: 'X', date: '2026-00-10' }), false);
});

test('validateEvent rejects non-date garbage', () => {
  assert.equal(validateEvent({ type: 'arrival', name: 'X', date: 'June 2026' }), false);
});

test('validateEvent normalizes endDate too', () => {
  const e = { type: 'absence', name: 'X', date: '2026-06-01', endDate: '2026-07' };
  assert.equal(validateEvent(e), true);
  assert.equal(e.endDate, '2026-07-01');
});

test('validateEvent allows missing date', () => {
  assert.equal(validateEvent({ type: 'note', note: 'no date here' }), true);
});

test('validateEvent rejects unknown type', () => {
  assert.equal(validateEvent({ type: 'wat', name: 'X' }), false);
});
