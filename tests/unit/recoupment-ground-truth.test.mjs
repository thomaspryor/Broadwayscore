// Ground-truth scoring for recoupment-model changes (BRO-5002). require()s the
// real helpers (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { groundTruth, rangeError, category, summarize, worseGroups, formatMarkdown } = require('../../scripts/lib/recoupment-ground-truth');

const closed = { closingDate: '2020-01-01', openingDate: '2019-01-01', type: 'musical' };

describe('groundTruth', () => {
  test('a reported range counts; our own inference does not', () => {
    assert.deepEqual(
      groundTruth({ estimatedRecoupmentPct: [20, 10], estimatedRecoupmentSource: 'NYT: part way there' }, closed),
      { kind: 'reported-pct', lo: 10, hi: 20, source: 'NYT: part way there' },
    );
    assert.equal(groundTruth({ estimatedRecoupmentPct: [30, 45], estimatedRecoupmentSource: 'Inferred: ~9 months run' }, {}), null);
    assert.equal(groundTruth({ estimatedRecoupmentPct: [30, 45], notes: 'Estimated: weekly profit x weeks' }, {}), null);
  });
  test('carries a dated report as asOf (for --as-of-report)', () => {
    const c = { estimatedRecoupmentPct: [10, 30], estimatedRecoupmentSource: 'Reddit grosses analysis' };
    assert.equal(groundTruth({ ...c, estimatedRecoupmentDate: '2026-02-18' }, closed).asOf, '2026-02-18');
    assert.equal('asOf' in groundTruth({ ...c, estimatedRecoupmentDate: 'Feb 2026' }, closed), false);
  });
  test('falls back to notes for the basis', () => {
    assert.equal(groundTruth({ estimatedRecoupmentPct: [10, 20], notes: 'Produced by X; NYT says part way' }, closed).kind, 'reported-pct');
  });
  test('cited recoupment is >= 100; an uncited one is not truth', () => {
    assert.deepEqual(groundTruth({ recouped: true, recoupedSource: 'Variety' }, {}).lo, 100);
    assert.equal(groundTruth({ recouped: true }, {}), null);
  });
  test('failed needs closed + not recouped + Fizzle/Flop', () => {
    assert.equal(groundTruth({ recouped: false, designation: 'Flop' }, closed).kind, 'failed');
    assert.equal(groundTruth({ recouped: false, designation: 'Flop' }, { closingDate: '2999-01-01' }), null);
    assert.equal(groundTruth({ recouped: false, designation: 'TBD' }, closed), null);
  });
});

describe('scoring', () => {
  test('rangeError is 0 inside, distance outside', () => {
    const t = { lo: 10, hi: 20 };
    assert.equal(rangeError(15, t), 0);
    assert.equal(rangeError(-5, t), 15);
    assert.equal(rangeError(30, t), 10);
    assert.equal(rangeError(250, { lo: 100, hi: Infinity }), 0);
    assert.equal(rangeError(null, t), null);
  });
  test('category splits type and era', () => {
    assert.deepEqual(category({ type: 'play', openingDate: '2019-05-01' }), { type: 'play', era: 'pre-2020' });
    assert.deepEqual(category({ type: 'musical', openingDate: '2024-05-01' }), { type: 'musical', era: '2020+' });
  });
  test('summarize and worseGroups flag fewer-inside even when mean error improves', () => {
    const rows = [
      { kind: 'failed', type: 'play', era: 'pre-2020', oldErr: 0, newErr: 2 },
      { kind: 'reported-pct', type: 'musical', era: '2020+', oldErr: 30, newErr: 10 },
      { kind: 'reported-pct', type: 'musical', era: '2020+', oldErr: 0, newErr: 0 },
    ];
    const s = summarize(rows);
    assert.equal(s.all.n, 3);
    assert.equal(s.all.oldMae, 10);
    assert.equal(s.all.newMae, 4);
    assert.equal(s['kind:reported-pct'].newMedian, 5);
    // all: mean 10 -> 4 but inside 2 -> 1, so it counts as worse too.
    assert.deepEqual(worseGroups(s).sort(), ['all', 'era:pre-2020', 'kind:failed', 'type:play']);
    // minN: one-row groups are not gated.
    assert.deepEqual(worseGroups(s, { minN: 2 }).sort(), ['all']);
  });
});

describe('formatMarkdown', () => {
  const row = (slug, oldErr, newErr) => ({ slug, kind: 'recouped', type: 'musical', era: '2020+', truth: [100, Infinity], oldPct: 100 - oldErr, newPct: 100 - newErr, oldErr, newErr });
  test('group table, moved rows by size of change, worse line', () => {
    const rows = [row('a', 10, 2), row('b', 5, 5), row('c', 0, 30)];
    const md = formatMarkdown({ title: 'T', summary: summarize(rows), rows, worse: ['all'] });
    assert.match(md, /^### T/);
    assert.match(md, /\| all \| 3 \| 5 \| 12\.3 \|/);
    assert.match(md, /Error changed on 2:/);
    assert.ok(md.indexOf('| c |') < md.indexOf('| a |'), 'biggest move first');
    assert.ok(!md.includes('| b |'), 'unmoved row not listed');
    assert.match(md, /\| c \| recouped \| 100\.\.\+inf \| 100 \| 70 \| 0 \| 30 \|/);
    assert.match(md, /\*\*Worse in:\*\* all/);
  });
  test('nothing moved', () => {
    const rows = [row('b', 5, 5)];
    const md = formatMarkdown({ title: 'T', summary: summarize(rows), rows, worse: [] });
    assert.match(md, /No row moved\./);
    assert.match(md, /No group got worse\./);
  });
});
