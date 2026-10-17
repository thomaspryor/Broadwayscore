import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyCandidate, effectiveDate, SPAN_TIGHT_DAYS } = require('../../scripts/detect-venue-transfers.js');

describe('detect-venue-transfers / classifyCandidate', () => {
  it('routes to an existing sibling entry when one covers the cluster', () => {
    assert.equal(classifyCandidate({ sibling: 'hadestown-2019', spanDays: 1500 }), 'routed-elsewhere');
    // sibling presence wins even on a tight span
    assert.equal(classifyCandidate({ sibling: 'waitress-2016', spanDays: 5 }), 'routed-elsewhere');
  });

  it('flags a tight, sibling-less, same-market cluster as a likely transfer', () => {
    assert.equal(classifyCandidate({ sibling: null, spanDays: 22, marketMatch: true }), 'likely-transfer');  // inter-alia (UK→UK)
    assert.equal(classifyCandidate({ sibling: null, spanDays: 520, marketMatch: true }), 'likely-transfer'); // Totoro double Barbican run
    assert.equal(classifyCandidate({ sibling: null, spanDays: SPAN_TIGHT_DAYS, marketMatch: true }), 'likely-transfer');
    // unknown market (null) is NOT suppressed — treated as a candidate
    assert.equal(classifyCandidate({ sibling: null, spanDays: 9, marketMatch: null }), 'likely-transfer');
  });

  it('flags a tight cross-market cluster as cross-market-transfer (excluded by policy)', () => {
    assert.equal(classifyCandidate({ sibling: null, spanDays: 9, marketMatch: false }), 'cross-market-transfer');   // Sunset (London→Broadway)
    assert.equal(classifyCandidate({ sibling: null, spanDays: 320, marketMatch: false }), 'cross-market-transfer'); // Godot
  });

  it('flags a wide, sibling-less cluster as needing manual review (multi-production risk)', () => {
    assert.equal(classifyCandidate({ sibling: null, spanDays: SPAN_TIGHT_DAYS + 1, marketMatch: true }), 'wide-span-review');
    assert.equal(classifyCandidate({ sibling: null, spanDays: 3650, marketMatch: false }), 'wide-span-review'); // wide span wins over market
  });
});

describe('detect-venue-transfers / effectiveDate', () => {
  it('prefers a parseable publishDate', () => {
    const d = effectiveDate({ publishDate: '2022-10-19' });
    assert.equal(d.toISOString().slice(0, 10), '2022-10-19');
  });

  it('falls back to the ISO date embedded in the flag note when publishDate is missing', () => {
    const d = effectiveDate({
      wrongProductionNote: 'Pre-opening guard: review dated 2022-10-19 is 90+ days before show starts',
    });
    assert.equal(d.toISOString().slice(0, 10), '2022-10-19');
  });

  it('falls back to a date embedded in wrongProductionReason', () => {
    const d = effectiveDate({ wrongProductionReason: 'Date guard: review 2023-01-15 is 555d before' });
    assert.equal(d.toISOString().slice(0, 10), '2023-01-15');
  });

  it('returns null when no date is recoverable', () => {
    assert.equal(effectiveDate({ wrongProductionNote: 'no date here' }), null);
    assert.equal(effectiveDate({}), null);
  });
});
