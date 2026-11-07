import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ibdbYearMismatch, expectedShowYear } = require('./ibdb-year-guard.js');

test('expectedShowYear: prefers existing dates, falls back to id-year suffix', () => {
  assert.equal(expectedShowYear({ openingDate: '2027-04-15', id: 'x-2026' }), 2027);
  assert.equal(expectedShowYear({ previewsStartDate: '2026-10-08', id: 'x-2026' }), 2026);
  assert.equal(expectedShowYear({ id: 'a-few-good-men-2026' }), 2026); // no dates → id year
  assert.equal(expectedShowYear({ id: 'no-year-suffix' }), null);
  assert.equal(expectedShowYear(null), null);
});

test('ibdbYearMismatch: rejects the original-production match on a new revival (the bug)', () => {
  // a-few-good-men-2026 (no dates yet) matched IBDB's 1989 original.
  assert.equal(ibdbYearMismatch({ id: 'a-few-good-men-2026' }, '1989-11-15'), true);
  assert.equal(ibdbYearMismatch({ id: 'the-sound-of-music-2026' }, '1998-03-12'), true);
  assert.equal(ibdbYearMismatch({ id: 'awake-and-sing-2026' }, '1935-02-19'), true);
});

test('ibdbYearMismatch: accepts a correct same-era IBDB match', () => {
  // the real 2026 production IS on IBDB.
  assert.equal(ibdbYearMismatch({ id: 'a-few-good-men-2026' }, '2026-10-29'), false);
  // season-year vs next-calendar-year opening is within tolerance.
  assert.equal(ibdbYearMismatch({ id: 'the-sound-of-music-2026' }, '2027-04-15'), false);
  // historical backfill: id year matches the real old opening.
  assert.equal(ibdbYearMismatch({ id: 'a-few-good-men-1989' }, '1989-11-15'), false);
});

test('ibdbYearMismatch: validates against an EXISTING date when present, not just the id', () => {
  // show already has the right 2026 opening; an IBDB 1989 result is still rejected.
  assert.equal(ibdbYearMismatch({ id: 'x-2026', openingDate: '2026-10-29' }, '1989-11-15'), true);
  // show has the right date and IBDB agrees.
  assert.equal(ibdbYearMismatch({ id: 'x-2026', openingDate: '2026-10-29' }, '2026-10-29'), false);
});

test('ibdbYearMismatch: cannot validate (no expected year, or no ibdb date) → does not block', () => {
  assert.equal(ibdbYearMismatch({ id: 'no-year' }, '1989-11-15'), false);
  assert.equal(ibdbYearMismatch({ id: 'x-2026' }, null), false);
  assert.equal(ibdbYearMismatch(null, '1989-11-15'), false);
});

test('ibdbYearMismatch: boundary — exactly 2 years is allowed, 3 is not', () => {
  assert.equal(ibdbYearMismatch({ id: 'x-2026' }, '2024-01-01'), false); // 2y
  assert.equal(ibdbYearMismatch({ id: 'x-2026' }, '2023-01-01'), true);  // 3y
});
