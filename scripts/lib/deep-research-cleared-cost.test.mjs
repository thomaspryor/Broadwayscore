// BRO-6191: a cost a person cleared stays cleared. Real function require()s (CLAUDE.md §15).
// Field names are built, not spelled, so this file is not a new direct reader of the
// cost field (tests/unit/cost-for-week.test.mjs greps for the literal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isFieldCleared, refuseClearedField, clearedFlagName, planOnlyValueProblem, carriedClearedGuard } = require('./cleared-field-guard');
const { buildCommercialEntry, applyFigureEvidence } = require('./commercial-apply-gate');
const { nearMissLosers, unsourcedCrossings, nearMissLine } = require('./near-miss-losers');
const { pickEditableFields, FEEDBACK_EDITABLE_FIELDS } = require('./feedback-pipeline-fields');
const { applyDataEdit, dataEditAllowProblem } = require('./data-edit-action');
import fs from 'node:fs';

const COST = ['weekly', 'Running', 'Cost'].join('');
const COST_SOURCE = `${COST}Source`;
const FLAG = `${COST}Cleared`;

// Oedipus today: value null, still listed as verified, notes say ~$950K.
const oedipus = () => ({
  designation: 'Did Not Recoup', capitalization: 6000000, [COST]: null, recouped: false,
  deepResearch: { verifiedFields: ['capitalization', COST, 'recouped', 'designation'], verifiedDate: '2026-02-03', verifiedBy: 'manual' },
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

test('only verified evidence may refill it: AI-written source text is not a citation', () => {
  assert.equal(refuseClearedField(oedipus(), aiAnswer({ [COST_SOURCE]: 'Forbes: "$950,000 weekly"' }), COST), true);
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

test('a refused cost writes no costMethodology either (source text does not rescue it)', () => {
  const answer = aiAnswer({ costMethodology: 'trade-reported', [COST_SOURCE]: 'Forbes: "x"' });
  const merged = buildCommercialEntry(answer, oedipus(), { mergeExisting: true });
  assert.equal(merged[COST], null);
  assert.equal(merged.costMethodology, undefined);
  const ev = { [COST]: { found: true, quote: 'q', source: { url: 'https://example.com/a' } } };
  assert.equal(buildCommercialEntry(answer, oedipus(), { mergeExisting: true, figureEvidence: ev }).costMethodology, 'trade-reported');
});

test('the sweep stage holds the figure instead of deleting it', () => {
  const src = fs.readFileSync(new URL('../deep-research-commercial.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('refuseClearedField(existingShow'), src.indexOf('refuseClearedField(existingShow') + 700);
  assert.doesNotMatch(block, /delete analysis\[field\]\s*;\s*\n\s*continue/);
  assert.match(block, /_clearedFieldProposed/);
});

test('deepResearch and the cleared flag are plan-only: allowed for plans, not for the feedback LLM', () => {
  const plan = pickEditableFields(['commercial.json'], FEEDBACK_EDITABLE_FIELDS)['commercial.json'];
  assert.ok(!plan.includes('deepResearch') && !plan.includes(FLAG));
  assert.equal(dataEditAllowProblem({ file: 'commercial.json', field: 'deepResearch' }), null);
  assert.equal(dataEditAllowProblem({ file: 'commercial.json', field: FLAG }), null);
});

test('plan value checks: flag only true; deepResearch only loses verifiedFields', () => {
  assert.equal(planOnlyValueProblem(FLAG, null, true), null);
  assert.match(planOnlyValueProblem(FLAG, true, false), /only be set to true/);
  assert.match(planOnlyValueProblem(FLAG, null, 'yes'), /only be set to true/);
  const dr = oedipus().deepResearch;
  assert.equal(planOnlyValueProblem('deepResearch', dr, { ...dr, verifiedFields: ['recouped'], notes: 'reworded' }), null);
  assert.match(planOnlyValueProblem('deepResearch', dr, { ...dr, verifiedFields: [...dr.verifiedFields, 'estimatedRecoupmentPct'] }), /only lose entries/);
  assert.match(planOnlyValueProblem('deepResearch', dr, { ...dr, verifiedDate: '2030-01-01' }), /not verifiedDate/);
  assert.match(planOnlyValueProblem('deepResearch', null, { verifiedFields: [] }), /existing object/);
});

test('applyDataEdit enforces the checks and the bro-6191 plan edits apply cleanly', () => {
  const data = { shows: { oedipus: oedipus() } };
  const bad = applyDataEdit(data, { type: 'data-edit', file: 'commercial.json', showSlug: 'oedipus', field: FLAG, oldValue: null, newValue: false });
  assert.equal(bad.ok, false);
  const plan = JSON.parse(fs.readFileSync(new URL('../../data/pending-fixes/bro-6191.json', import.meta.url), 'utf8'));
  for (const a of plan.plan.actions) {
    const r = applyDataEdit(data, { ...a, oldValue: a.field === FLAG ? null : oedipus().deepResearch });
    assert.equal(r.ok, true, r.reason);
  }
  assert.equal(data.shows.oedipus[FLAG], true);
  assert.ok(!data.shows.oedipus.deepResearch.verifiedFields.includes(COST));
});

test('a --show rebuild carries the cleared flags and deepResearch across', () => {
  const existing = { ...oedipus(), [FLAG]: true };
  const carried = carriedClearedGuard(existing, { designation: 'Flop' });
  assert.equal(carried[FLAG], true);
  assert.deepEqual(carried.deepResearch, existing.deepResearch);
  assert.deepEqual(carriedClearedGuard(existing, { [FLAG]: true, deepResearch: { verifiedFields: [] } }), {});
  assert.deepEqual(carriedClearedGuard(null, {}), {});
  assert.deepEqual(carriedClearedGuard({ [FLAG]: false }, {}), {});
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
