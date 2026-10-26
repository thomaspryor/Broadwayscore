// BRO-5020: every Fizzle/Flop a writer assigns says what it rests on
// (designationBasis, owner policy B). update-commercial-data still needs a
// high-confidence cited loss, and stamps it 'reported-loss'.
// Requires the real functions (no inline copies).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// applyChanges writes commercial.json unless --dry-run (own process per file).
process.argv.push('--dry-run');
const { filterByConfidence, applyChanges } = require('../../scripts/update-commercial-data.js');

const data = { shows: { 'x-show': { designation: 'TBD' } } };
const change = (newValue, confidence) => ({ slug: 'x-show', field: 'designation', oldValue: 'TBD', newValue, confidence, source: 'test' });

describe('update-commercial-data loss-label freeze', () => {
  for (const loss of ['Fizzle', 'Flop', 'Did Not Recoup']) {
    it(`flags TBD -> ${loss} at medium confidence instead of applying it`, () => {
      const r = filterByConfidence([change(loss, 'medium')], data);
      assert.equal(r.applied.length, 0);
      assert.equal(r.flagged.length, 1);
      assert.match(r.flagged[0].flagReason, /cited loss source/);
    });
    it(`applies TBD -> ${loss} at high confidence (directly stated loss)`, () => {
      const r = filterByConfidence([change(loss, 'high')], data);
      assert.equal(r.applied.length, 1);
    });
  }
  it('still applies TBD -> Windfall at medium confidence (unchanged)', () => {
    const r = filterByConfidence([change('Windfall', 'medium')], data);
    assert.equal(r.applied.length, 1);
  });
});

describe('update-commercial-data applyChanges stamps designationBasis', () => {
  const run = (row, newValue) => {
    const commercial = { _meta: {}, shows: { 'x-show': { ...row } } };
    applyChanges([{ slug: 'x-show', field: 'designation', oldValue: row.designation, newValue, confidence: 'high', source: 'Deadline' }], [], commercial, new Map());
    return commercial.shows['x-show'];
  };
  it('a loss label from a sourced article is a reported loss and drops the evidence flag', () => {
    const r = run({ designation: 'TBD', needsLossEvidence: true, estimatedRecoupmentPct: [0, 10] }, 'Flop');
    assert.equal(r.designation, 'Flop');
    assert.equal(r.designationBasis, 'reported-loss');
    assert.equal('needsLossEvidence' in r, false);
  });
  it('sizes the loss label it writes by the record\'s own estimate, whatever was proposed (BRO-5636)', () => {
    assert.equal(run({ designation: 'TBD' }, 'Flop').designation, 'Did Not Recoup'); // no estimate behind a size
    assert.equal(run({ designation: 'TBD', modelDataQuality: 'medium', modelReturnedExCreditPct: [20, 40, 60] }, 'Did Not Recoup').designation, 'Fizzle');
    assert.equal(run({ designation: 'TBD', modelDataQuality: 'low', modelReturnedExCreditPct: [20, 40, 60] }, 'Fizzle').designation, 'Did Not Recoup');
    // An estimate applied in the same batch counts.
    const commercial = { _meta: {}, shows: { 'x-show': { designation: 'TBD' } } };
    applyChanges([
      { slug: 'x-show', field: 'designation', oldValue: 'TBD', newValue: 'Did Not Recoup', confidence: 'high', source: 'Deadline' },
      { slug: 'x-show', field: 'estimatedRecoupmentPct', oldValue: null, newValue: [0, 5], confidence: 'high', source: 'Deadline' },
    ], [], commercial, new Map());
    assert.equal(commercial.shows['x-show'].designation, 'Flop');
    // An estimate alone sizes a loss label already on the row.
    const dnr = { _meta: {}, shows: { 'x-show': { designation: 'Did Not Recoup', recouped: false, designationBasis: 'reported-loss' } } };
    applyChanges([{ slug: 'x-show', field: 'estimatedRecoupmentPct', oldValue: null, newValue: [35, 45], confidence: 'high', source: 'Deadline' }], [], dnr, new Map());
    assert.equal(dnr.shows['x-show'].designation, 'Fizzle');
    // A locked label is left as a person set it.
    const locked = { _meta: {}, shows: { 'x-show': { designation: 'Did Not Recoup', recouped: false, humanReviewedDesignation: true } } };
    applyChanges([{ slug: 'x-show', field: 'estimatedRecoupmentPct', oldValue: null, newValue: [35, 45], confidence: 'high', source: 'Deadline' }], [], locked, new Map());
    assert.equal(locked.shows['x-show'].designation, 'Did Not Recoup');
  });
  it('a win label clears a stale loss basis', () => {
    const r = run({ designation: 'Fizzle', designationBasis: 'no-recoupment-announced' }, 'Windfall');
    assert.equal(r.designation, 'Windfall');
    assert.equal('designationBasis' in r, false);
  });
  it('recoupment news flips a silence-basis loss back to TBD; a reported loss is left for a person', () => {
    const flip = (row) => {
      const commercial = { _meta: {}, shows: { 'x-show': { ...row } } };
      applyChanges([{ slug: 'x-show', field: 'recouped', oldValue: row.recouped, newValue: true, confidence: 'high', source: 'Deadline' }], [], commercial, new Map());
      return commercial.shows['x-show'];
    };
    const r = flip({ designation: 'Fizzle', recouped: false, designationBasis: 'no-recoupment-announced' });
    assert.equal(r.designation, 'TBD');
    assert.equal(r.recouped, true);
    assert.equal('designationBasis' in r, false);
    assert.equal(flip({ designation: 'Flop', recouped: false, designationBasis: 'reported-loss' }).designation, 'Flop');
  });
  it('a win label settles the evidence flag; TBD keeps it', () => {
    assert.equal('needsLossEvidence' in run({ designation: 'TBD', needsLossEvidence: true }, 'Windfall'), false);
    assert.equal(run({ designation: 'Fizzle', needsLossEvidence: true }, 'TBD').needsLossEvidence, true);
  });
});

describe('commercial-record-checks designationBasis rules', () => {
  const { commercialRecordErrors, commercialRecordWarnings } = require('../../scripts/lib/commercial-record-checks.js');
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const loss = { designation: 'Fizzle', recouped: false };
  it('rejects an unknown basis value', () => {
    assert.ok(commercialRecordErrors('x', { ...loss, designationBasis: 'vibes' }).some(m => /invalid designationBasis/.test(m)));
    assert.equal(commercialRecordErrors('x', { ...loss, designationBasis: 'reported-loss' }).filter(m => /designationBasis/.test(m)).length, 0);
  });
  it('warns on a loss label with no basis, and on a basis on a non-loss label', () => {
    assert.ok(commercialRecordWarnings('x', loss).some(m => /no designationBasis/.test(m)));
    assert.ok(commercialRecordWarnings('x', { designation: 'TBD', designationBasis: 'reported-loss' }).some(m => /non-loss/.test(m)));
  });
  it('no longer warns about a silence-based label on a young closure (owner 2026-10-24, BRO-6158)', () => {
    const row = { ...loss, designationBasis: 'no-recoupment-announced' };
    const w = (d) => commercialRecordWarnings('x', row, { showRecord: { status: 'closed', closingDate: daysAgo(d) } });
    for (const d of [3, 60, 400]) assert.equal(w(d).filter(m => /ages in/.test(m)).length, 0, `${d} days`);
    // A model-estimate label on a young closure is clean and needs no recouped flag.
    const est = { designation: 'Flop', recouped: null, designationBasis: 'model-estimate', modelReturnedExCreditPct: [5, 10, 15] };
    assert.deepEqual(commercialRecordErrors('x', est, { showRecord: { status: 'closed', closingDate: daysAgo(3) } }), []);
  });
  it('warns when a recouped show still carries an earlier share returned (BRO-5091)', () => {
    const w = (est) => commercialRecordWarnings('x', { designation: 'Windfall', recouped: true, estimatedRecoupmentPct: est });
    assert.ok(w([65, 75]).some(m => /earlier share returned/.test(m)));
    assert.equal(w([100, 120]).filter(m => /earlier share returned/.test(m)).length, 0);
    assert.equal(w(null).filter(m => /earlier share returned/.test(m)).length, 0);
  });
  it('warns when a hard-sourced all-in or breakeven cost has no basis tag (BRO-5093)', () => {
    const rec = (extra) => ({ designation: 'TBD', costMethodology: 'trade-reported', weeklyRunningCost: 900000, weeklyRunningCostSource: 'Variety: breakeven is about $900,000 a week', ...extra });
    const hit = (r) => commercialRecordWarnings('x', r).some(m => /no weeklyRunningCostBasis/.test(m));
    assert.ok(hit(rec({})));
    assert.equal(hit(rec({ weeklyRunningCostBasis: 'breakeven' })), false);
    assert.equal(hit(rec({ costMethodology: 'deep-research' })), false);
    assert.equal(hit(rec({ weeklyRunningCostSource: 'Variety: weekly running costs of $900,000' })), false);
    // Shapes a reviewer flagged: a cue only in the URL, negations, "all in all".
    assert.equal(hit(rec({ weeklyRunningCostSource: 'Variety: running costs of $900,000 https://variety.com/all-in-costs' })), false);
    assert.equal(hit(rec({ weeklyRunningCostSource: 'Variety: $900,000 a week, not all-in' })), false);
    assert.equal(hit(rec({ weeklyRunningCostSource: 'Variety: all in all, $900,000 a week to run' })), false);
    assert.ok(hit(rec({ weeklyRunningCostSource: 'Variety: the show breaks even at $900,000' })));
  });

  it('lets the add-entry path set weeklyRunningCostBasis (BRO-5093)', () => {
    assert.ok(require('../../scripts/lib/commercial-entry-action.js').ALLOWED_ENTRY_FIELDS.has('weeklyRunningCostBasis'));
  });
});
