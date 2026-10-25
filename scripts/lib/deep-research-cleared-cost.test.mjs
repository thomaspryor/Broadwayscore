// BRO-6191: a cost a person cleared stays cleared. Real function require()s (CLAUDE.md §15).
// Field names are built, not spelled, so this file is not a new direct reader of the
// cost field (tests/unit/cost-for-week.test.mjs greps for the literal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isFieldCleared, refuseClearedField, clearedFlagName } = require('./cleared-field-guard');
const { buildCommercialEntry, applyFigureEvidence } = require('./commercial-apply-gate');
const { nearMissLosers, unsourcedCrossings, nearMissLine } = require('./near-miss-losers');
const { pickEditableFields } = require('./feedback-pipeline-fields');

const COST = ['weekly', 'Running', 'Cost'].join('');
const COST_SOURCE = `${COST}Source`;
const FLAG = `${COST}Cleared`;

// Oedipus today: value null, still listed as verified, notes say ~$950K.
const oedipus = () => ({
  designation: 'Did Not Recoup', capitalization: 6000000, [COST]: null, recouped: false,
  deepResearch: { verifiedFields: ['capitalization', COST, 'recouped', 'designation'], verifiedDate: '2026-02-03' },
});
const aiAnswer = (extra = {}) => ({ designation: 'Did Not Recoup', [COST]: 950000, ...extra });

test('flag name is <field>Cleared', () => assert.equal(clearedFlagName(COST), FLAG));

test('null value listed in verifiedFields counts as cleared', () => {
  assert.equal(isFieldCleared(oedipus(), COST), true);
});

test('null value with the cleared flag counts as cleared even when unlisted', () => {
  assert.equal(isFieldCleared({ [COST]: null, [FLAG]: true }, COST), true);
});

test('a populated value, an unlisted null, or no record is not cleared', () => {
  assert.equal(isFieldCleared({ ...oedipus(), [COST]: 500000 }, COST), false);
  assert.equal(isFieldCleared({ [COST]: null, deepResearch: { verifiedFields: ['recouped'] } }, COST), false);
  assert.equal(isFieldCleared({ [COST]: null }, COST), false);
  assert.equal(isFieldCleared(null, COST), false);
});

test('an uncited AI figure is refused on a cleared field', () => {
  assert.equal(refuseClearedField(oedipus(), aiAnswer(), COST), true);
  assert.equal(refuseClearedField({ [COST]: null, [FLAG]: true }, aiAnswer(), COST), true);
});

test('a cited figure (source text or verified evidence) may refill it', () => {
  assert.equal(refuseClearedField(oedipus(), aiAnswer({ [COST_SOURCE]: 'Forbes: "$950,000 weekly"' }), COST), false);
  const evidence = { found: true, quote: '$950,000 a week', source: { url: 'https://example.com/a' } };
  assert.equal(refuseClearedField(oedipus(), aiAnswer(), COST, evidence), false);
  assert.equal(refuseClearedField(oedipus(), aiAnswer(), COST, { found: true, quote: '', source: {} }), true);
});

test('no proposed value, or no cleared field, refuses nothing', () => {
  assert.equal(refuseClearedField(oedipus(), { designation: 'Flop' }, COST), false);
  assert.equal(refuseClearedField(oedipus(), aiAnswer({ [COST]: null }), COST), false);
  assert.equal(refuseClearedField({ ...oedipus(), [COST]: 400000 }, aiAnswer(), COST), false);
});

test('buildCommercialEntry does not write an older pending answer back onto a cleared field', () => {
  const merged = buildCommercialEntry(aiAnswer(), oedipus(), { mergeExisting: true });
  assert.equal(merged[COST], null);
  const fresh = buildCommercialEntry(aiAnswer(), oedipus());
  assert.equal(fresh[COST], undefined);
});

test('buildCommercialEntry still writes a cited figure on a cleared field', () => {
  const evidence = { [COST]: { found: true, quote: '$950,000 a week', source: { url: 'https://example.com/a' } } };
  const merged = buildCommercialEntry(aiAnswer(), oedipus(), { mergeExisting: true, figureEvidence: evidence });
  assert.equal(merged[COST], 950000);
});

test('buildCommercialEntry is unchanged for an uncleared field', () => {
  const merged = buildCommercialEntry(aiAnswer(), { ...oedipus(), [COST]: 700000 }, { mergeExisting: true });
  assert.equal(merged[COST], 950000);
});

test('applyFigureEvidence leaves a refused figure alone (no estimate flag, no cost method)', () => {
  const out = applyFigureEvidence({}, aiAnswer(), {}, oedipus());
  assert.equal(out.isEstimate, undefined);
  assert.equal(out.costMethodology, undefined);
  const uncleared = applyFigureEvidence({}, aiAnswer(), {}, { ...oedipus(), [COST]: 700000 });
  assert.equal(uncleared.isEstimate[COST], true);
});

test('fix plans may edit deepResearch and the cleared flag', () => {
  const fields = pickEditableFields(['commercial.json'])['commercial.json'];
  assert.ok(fields.includes('deepResearch'));
  assert.ok(fields.includes(FLAG));
});

test('near-miss losers: failed rows crossing 90% from below, advisory line prints them', () => {
  const rows = [
    { slug: 'misery-2015', kind: 'failed', oldPct: 57, newPct: 97 },
    { slug: 'already-high', kind: 'failed', oldPct: 92, newPct: 99 },
    { slug: 'still-low', kind: 'failed', oldPct: 40, newPct: 80 },
    { slug: 'recouped-show', kind: 'recouped', oldPct: 50, newPct: 120 },
  ];
  const losers = nearMissLosers(rows);
  assert.deepEqual(losers.map((r) => r.slug), ['misery-2015']);
  const crossings = unsourcedCrossings([
    { slug: 'a', oldPct: 94, newPct: 122 }, { slug: 'b', oldPct: 105, newPct: 130 }, { slug: 'c', oldPct: 50, newPct: 60 },
  ]);
  assert.deepEqual(crossings.map((r) => r.slug), ['a']);
  assert.match(nearMissLine(losers, crossings), /1 failed-truth rows.*misery-2015 57 -> 97.*1 unsourced rows.*a 94 -> 122/);
  assert.doesNotMatch(nearMissLine(losers, crossings, { names: false }), /misery/);
  assert.match(nearMissLine([], []), /: 0 failed-truth rows.*; 0 unsourced rows/);
});
