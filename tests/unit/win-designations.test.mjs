// Recouped (owner 2026-10-31, BRO-5641, Option B): the win-side twin of Did
// Not Recoup. Trickle and Windfall say how much came back, so they rest on a
// reported investorMultiple; a recouped open-ended run with none is Recouped.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const D = require('../../scripts/lib/commercial-designations');
const { proposeDesignation } = require('../../scripts/lib/designation-rule');
const { commercialRecordErrors, commercialRecordWarnings } = require('../../scripts/lib/commercial-record-checks');
const { estimateFitsDesignation } = require('../../scripts/lib/model-display-guard');
const { DESIGNATION_CRITERIA } = require('../../scripts/lib/commercial-scope');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Recouped label', () => {
  it('is a valid, recouped, reported designation that canonicalizes from LLM spellings', () => {
    assert.equal(D.RECOUPED, 'Recouped');
    assert.ok(D.VALID_DESIGNATIONS.includes('Recouped'));
    assert.ok(D.RECOUPED_DESIGNATIONS.includes('Recouped'));
    assert.ok(D.REPORTED_WIN_DESIGNATIONS.includes('Recouped'), 'never our estimate');
    assert.ok(!D.MODEST_RETURN_DESIGNATIONS.includes('Recouped'), 'names no multiple');
    assert.equal(D.canonicalDesignation('recouped'), 'Recouped');
    assert.equal(D.canonicalDesignation(' RECOUPED '), 'Recouped');
  });
  it('isRecoupedDesignation is exactly RECOUPED_DESIGNATIONS and never a loss label', () => {
    for (const d of D.VALID_DESIGNATIONS) {
      assert.equal(D.isRecoupedDesignation(d), D.RECOUPED_DESIGNATIONS.includes(d), d);
      if (D.isRecoupedDesignation(d)) assert.equal(D.isLossDesignation(d), false, d);
    }
    for (const x of [undefined, null, 'TBD', 'Did Not Recoup', 'Wait & See']) assert.equal(D.isRecoupedDesignation(x), false, String(x));
  });
  it('recoupedDesignationFor sizes by the reported multiple, Recouped without one', () => {
    assert.equal(D.recoupedDesignationFor(undefined), 'Recouped');
    assert.equal(D.recoupedDesignationFor(null), 'Recouped');
    assert.equal(D.recoupedDesignationFor(NaN), 'Recouped');
    assert.equal(D.recoupedDesignationFor(1), 'Trickle');
    assert.equal(D.recoupedDesignationFor(D.TRICKLE_MAX_MULTIPLE - 0.01), 'Trickle');
    assert.equal(D.recoupedDesignationFor(D.TRICKLE_MAX_MULTIPLE), 'Windfall');
    assert.equal(D.recoupedDesignationFor(4), 'Windfall');
  });
  it('a modelled loss below zero contradicts Recouped like the other wins', () => {
    assert.equal(D.modelContradictsDesignation(-10, 'Recouped'), true);
    assert.equal(D.modelContradictsDesignation(80, 'Recouped'), false);
  });
  it('the site config has a Recouped entry on the status-open token, and the LLM criteria define it', () => {
    const ts = fs.readFileSync(path.join(ROOT, 'src/config/commercial.ts'), 'utf8');
    const entry = ts.slice(ts.indexOf("name: 'Recouped',"), ts.indexOf("name: 'Squeaker',"));
    assert.match(entry, /color: 'text-status-open'/);
    assert.match(entry, /bgClass: 'bg-status-open-bg'/);
    assert.match(entry, /borderClass: 'border-status-open\/20'/);
    assert.match(entry, /description: '[^']*not been reported/);
    assert.match(DESIGNATION_CRITERIA, /^- Recouped: .*no source reports the return multiple/m);
  });
});

describe('designation rule: recouped open-ended runs', () => {
  const NOW = Date.parse('2026-10-31');
  const running = { openingDate: '2019-04-17' };
  const p = (record, show = running) => proposeDesignation({ record: { recouped: true, ...record }, show, model: null, now: NOW });
  it('moves a Windfall or Trickle with no reported multiple to Recouped (hadestown, and-juliet)', () => {
    for (const designation of ['Windfall', 'Trickle', 'TBD']) {
      const r = p({ designation });
      assert.equal(r.designation, 'Recouped', designation);
      assert.equal(r.changed, true, designation);
      assert.equal(r.basis, 'reported', designation);
    }
  });
  it('keeps a Recouped with no multiple, sizes one that gains a reported multiple', () => {
    assert.equal(p({ designation: 'Recouped' }).changed, false);
    assert.equal(p({ designation: 'Recouped', investorMultiple: 1.06 }).designation, 'Trickle');
    assert.equal(p({ designation: 'Recouped', investorMultiple: 2.5 }).designation, 'Windfall');
  });
  it('a reported multiple still splits Trickle from Windfall', () => {
    assert.equal(p({ designation: 'Windfall', investorMultiple: 1.2 }).designation, 'Trickle');
    assert.equal(p({ designation: 'Trickle', investorMultiple: 1.6 }).designation, 'Windfall');
  });
  it('leaves decade-plus Miracles and the classes outside the rule alone', () => {
    assert.equal(p({ designation: 'Miracle' }, { openingDate: '2015-08-06' }).changed, false);
    for (const designation of D.DESIGNATIONS_OUTSIDE_RULE) assert.equal(p({ designation }).changed, false, designation);
  });
  it('never proposes Recouped for a show that did not report recouping', () => {
    const closed = { openingDate: '2022-01-01', closingDate: '2023-01-01' };
    assert.notEqual(p({ designation: 'TBD', recouped: false }, closed).designation, 'Recouped');
    assert.equal(p({ designation: 'TBD', recouped: null }, closed).changed, false);
  });
});

describe('record checks', () => {
  const base = { recouped: true, recoupedDate: '2020-01', recoupedSource: 'Trade report: recouped its capitalization.' };
  const warn = (rec, ctx = {}) => commercialRecordWarnings('k', { ...base, ...rec }, ctx).filter((m) => /investorMultiple/.test(m));
  it('flags a reported Windfall or Trickle with no multiple, and a Recouped that has one', () => {
    assert.equal(warn({ designation: 'Windfall' }).length, 1);
    assert.equal(warn({ designation: 'Trickle' }).length, 1);
    assert.match(warn({ designation: 'Recouped', investorMultiple: 1.8 })[0], /sizes it "Windfall"/);
    assert.deepEqual(warn({ designation: 'Recouped' }), []);
    assert.deepEqual(warn({ designation: 'Windfall', investorMultiple: 2 }), []);
    assert.deepEqual(warn({ designation: 'Trickle', investorMultiple: 1.1 }), []);
  });
  it('leaves model-estimate tiers and unrelated edits alone', () => {
    assert.deepEqual(warn({ designation: 'Trickle', recouped: null, designationBasis: 'model-estimate' }), []);
    const prior = { ...base, designation: 'Windfall' };
    assert.deepEqual(warn({ designation: 'Windfall', notes: 'edited' }, { priorRecord: prior }), []);
    assert.equal(warn({ designation: 'Windfall' }, { priorRecord: { ...prior, designation: 'TBD' } }).length, 1);
  });
  it('Recouped needs recouped:true and is never a model estimate', () => {
    const errs = (rec) => commercialRecordErrors('k', { ...base, ...rec });
    assert.deepEqual(errs({ designation: 'Recouped' }).filter((m) => /Recouped/.test(m)), []);
    assert.ok(errs({ designation: 'Recouped', recouped: null }).some((m) => /recouped=null/.test(m)));
    assert.ok(errs({ designation: 'Recouped', designationBasis: 'model-estimate' }).some((m) => /model estimate/.test(m)));
  });
  it('an owner figure past 100% fits a Recouped label', () => {
    assert.equal(estimateFitsDesignation([100, 140], 'Recouped', true), true);
    assert.equal(estimateFitsDesignation([60, 90], 'Recouped', true), false);
  });
});

describe('research writer (update-commercial-data filterByConfidence)', () => {
  const { filterByConfidence } = require('../../scripts/update-commercial-data');
  const data = { shows: { s: { designation: 'TBD', recouped: true, recoupedDate: '2024-01' } } };
  const change = (newValue, extra = {}) => ({ slug: 's', field: 'designation', oldValue: 'TBD', newValue, confidence: 'high', ...extra });
  it('holds an unsized Trickle or Windfall for a person, applies Recouped', () => {
    for (const d of ['Trickle', 'Windfall']) {
      const r = filterByConfidence([change(d)], data);
      assert.equal(r.applied.length, 0, d);
      assert.match(r.flagged[0].flagReason, /investorMultiple/, d);
    }
    assert.equal(filterByConfidence([change('Recouped')], data).applied.length, 1);
  });
  it('applies a Trickle or Windfall that a reported multiple sizes', () => {
    const withMultiple = { shows: { s: { ...data.shows.s, investorMultiple: 1.2 } } };
    assert.equal(filterByConfidence([change('Trickle')], withMultiple).applied.length, 1);
    const proposed = [change('Windfall'), { slug: 's', field: 'investorMultiple', oldValue: null, newValue: 2.1, confidence: 'high' }];
    assert.ok(filterByConfidence(proposed, data).applied.some((c) => c.field === 'designation'));
  });
});
