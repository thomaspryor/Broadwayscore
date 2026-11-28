// BRO-3040: the Tony half of the cutoff-freshness alarm could never fire
// because a missing lastVerified defaulted to today. These tests use the
// real decision functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findMissingLastVerified, findStaleCutoffs } = require('./lib/cutoff-freshness.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const provisional2027 = { label: '2026-27', end: '2027-04-25', lastVerified: '2026-04-28' };

test('a record with no lastVerified is reported missing, not treated as fresh', () => {
  const missing = findMissingLastVerified([{ label: 'a', end: '2027-04-25' }, provisional2027, { label: 'b', end: '2027-04-25', lastVerified: 'soon' }]);
  assert.deepEqual(missing.map((r) => r.label), ['a', 'b']);
});

test('an old stamp trips the alarm once the cutoff is within 60 days', () => {
  const stale = findStaleCutoffs([provisional2027], '2027-03-01');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].daysToEnd, 55);
});

test('no alarm while the cutoff is more than 60 days away, or already past', () => {
  assert.equal(findStaleCutoffs([provisional2027], '2026-10-13').length, 0);
  assert.equal(findStaleCutoffs([provisional2027], '2027-05-01').length, 0);
});

test('a fresh stamp inside the window does not alarm', () => {
  assert.equal(findStaleCutoffs([{ ...provisional2027, lastVerified: '2027-02-20' }], '2027-03-01').length, 0);
});

test('every Tony record in src/lib/tony-cutoffs.ts carries a lastVerified date', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'lib', 'tony-cutoffs.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const TONY_CUTOFFS'));
  const records = body.slice(0, body.indexOf('];')).split(/\n  \{\n/).slice(1);
  assert.ok(records.length >= 14, `expected 14+ records, parsed ${records.length}`);
  for (const rec of records) assert.match(rec, /lastVerified: '\d{4}-\d{2}-\d{2}'/, rec.slice(0, 80));
});

test('an impossible calendar date counts as missing, not as a date that never ages', () => {
  const missing = findMissingLastVerified([{ label: 'x', end: '2027-04-25', lastVerified: '2026-02-30' }, { label: 'y', end: '2027-04-25', lastVerified: '2026-02-28' }]);
  assert.deepEqual(missing.map((r) => r.label), ['x']);
});

// BRO-3040 retro-review (BRO-5261): a future stamp (typo) never ages, so it
// counts as invalid when the caller passes today.
test('a lastVerified in the future is invalid', () => {
  const recs = [{ label: 'f', end: '2027-04-25', lastVerified: '2062-10-13' }, { label: 'ok', end: '2027-04-25', lastVerified: '2026-10-13' }];
  assert.deepEqual(findMissingLastVerified(recs, '2026-10-14').map((r) => r.label), ['f']);
  assert.deepEqual(findMissingLastVerified(recs).map((r) => r.label), []);
});
