// Squeaker and Wait & See (owner 2026-10-29, BRO-6499). Real functions only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const D = require('../../scripts/lib/commercial-designations');
const { commercialRecordErrors, commercialRecordWarnings } = require('../../scripts/lib/commercial-record-checks');
const { proposeDesignation } = require('../../scripts/lib/designation-rule');
const { estimateFitsDesignation } = require('../../scripts/lib/model-display-guard');

const src = [{ type: 'trade', url: 'https://example.com/a', date: '2026-01-01' }];

describe('label lists', () => {
  it('are valid, Squeaker recouped and reported, Wait & See unrecouped but not a loss', () => {
    assert.ok(D.VALID_DESIGNATIONS.includes('Squeaker') && D.VALID_DESIGNATIONS.includes('Wait & See'));
    assert.ok(D.RECOUPED_DESIGNATIONS.includes('Squeaker'));
    assert.ok(D.REPORTED_WIN_DESIGNATIONS.includes('Squeaker'));
    assert.ok(!D.MODEST_RETURN_DESIGNATIONS.includes('Squeaker'));
    assert.equal(D.isLossDesignation('Wait & See'), false);
    assert.equal(D.isUnrecoupedDesignation('Wait & See'), true);
    assert.equal(D.isUnrecoupedDesignation('Flop'), true);
    assert.equal(D.isUnrecoupedDesignation('Squeaker'), false);
    assert.equal(D.canonicalDesignation('wait-and-see'), 'Wait & See');
    assert.equal(D.canonicalDesignation('Wait and See'), 'Wait & See');
    assert.equal(D.canonicalDesignation('wait & see'), 'Wait & See');
    assert.equal(D.canonicalDesignation('SQUEAKER'), 'Squeaker');
  });
  it('automatic sizing never picks either label', () => {
    for (const pct of [0, 30, 55, 99]) assert.ok(!['Squeaker', 'Wait & See'].includes(D.lossDesignationFor(pct)));
    for (const pct of [55, 120, 200]) {
      const d = D.estimatedDesignationForClosed({ estimatedRecoupmentPct: pct });
      assert.ok(!['Squeaker', 'Wait & See'].includes(d), String(d));
    }
  });
  it('the designation rule leaves both alone', () => {
    for (const designation of ['Squeaker', 'Wait & See']) {
      const r = proposeDesignation({ record: { designation, recouped: designation === 'Squeaker' }, show: { closingDate: '2020-01-01' }, model: null });
      assert.equal(r.changed, false, designation);
    }
  });
  it('modelPctWithoutCredit takes the credit share back out', () => {
    const e = { capitalization: 5e6, modelTaxCreditCounted: 1e6, modelReturnedExCreditPct: [90, 110, 130] };
    assert.equal(D.modelPctWithoutCredit(e), 90);
    assert.equal(D.modelPctWithoutCredit({ modelReturnedExCreditPct: [90, 110, 130] }), null);
  });
  it('a Wait & See estimate fits 50 to under 100 only', () => {
    assert.equal(estimateFitsDesignation([50, 60, 70], 'Wait & See'), true);
    assert.equal(estimateFitsDesignation([20, 30, 40], 'Wait & See'), false);
    assert.equal(estimateFitsDesignation([90, 105, 120], 'Wait & See'), false);
  });
});

describe('validator', () => {
  const base = { capitalization: 5e6, sources: src };
  const errs = (rec) => commercialRecordErrors('x', rec);
  it('Squeaker needs recouped true and a citation naming the tax credit', () => {
    const ok = { ...base, designation: 'Squeaker', recouped: true, recoupedDate: '2026-06', recoupedSource: 'Deadline: recouped from run profits plus the NY State tax credit' };
    assert.deepEqual(errs(ok).filter((e) => /Squeaker|win-designations/.test(e)), []);
    assert.ok(errs({ ...ok, recoupedSource: 'Deadline: recouped' }).some((e) => /tax credit/.test(e)));
    assert.ok(errs({ ...ok, recouped: null }).some((e) => /recouped=null/.test(e)));
    assert.ok(errs({ ...ok, recouped: null, designationBasis: 'model-estimate' }).some((e) => /model estimate/.test(e)));
  });
  it('Squeaker past 100% on our model without the credit warns unless a person reviewed the label', () => {
    const rec = { ...base, designation: 'Squeaker', recouped: true, recoupedDate: '2026', recoupedSource: 'recouped with the NY State tax credit', capitalization: 8e6, modelTaxCreditCounted: 3e6, modelReturnedExCreditPct: [157, 184, 205] };
    assert.ok(commercialRecordWarnings('x', rec).some((e) => /even without the NY tax credit/.test(e)));
    assert.ok(!commercialRecordWarnings('x', { ...rec, humanReviewedDesignation: true }).some((e) => /even without the NY tax credit/.test(e)));
  });
  it('Wait & See needs recouped false, a cited 50-99% estimate and a closed run', () => {
    const ok = { ...base, designation: 'Wait & See', recouped: false, analystRecoupPct: [60, 60] };
    assert.deepEqual(errs(ok).filter((e) => /Wait & See/.test(e)), []);
    assert.ok(errs({ ...ok, recouped: true }).some((e) => /Wait & See/.test(e)));
    assert.ok(errs({ ...ok, analystRecoupPct: [40, 40] }).some((e) => /40%/.test(e)));
    assert.ok(errs({ ...ok, analystRecoupPct: null }).some((e) => /missing/.test(e)));
    assert.ok(errs({ ...ok, sources: [] }).some((e) => /no source/.test(e)));
    const w = commercialRecordWarnings('x', ok, { showRecord: { status: 'open' } });
    assert.ok(w.some((e) => /closed runs/.test(e)));
  });
});

describe('Wait & See counts as not recouped downstream', () => {
  it('a recoupment report does not lay recouped:true over a Wait & See label', () => {
    const { recoupClaimDesignationAction } = require('../../scripts/lib/commercial-apply-gate');
    assert.equal(recoupClaimDesignationAction({ designation: 'Wait & See', humanReviewedDesignation: true }), 'block');
    assert.equal(recoupClaimDesignationAction({ designation: 'Wait & See' }), 'block');
  });
  it('stunt-casting outcome: Wait & See is not recouped, Squeaker is recouped', () => {
    const { commercialOutcome } = require('../../scripts/lib/stunt-casting');
    assert.equal(commercialOutcome('Wait & See'), 'not-recouped');
    assert.equal(commercialOutcome('Squeaker'), 'recouped');
  });
});
