import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  armFamily, classifySample, detectProviderOutage, detectRecallRegression, parseTrendJsonl,
  perArmRecall, perCategoryRecall, summarizeRun,
} = require('./census-recall.js');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-02T12:00:00Z');

/** Report row shaped like audit-serp-census-recall.js writes them. */
function row({ id = 's', market = 'broadway', truth, arms, onDisk = 0, naiveOnly = 0, opening = '2026-07-01' }) {
  return {
    showId: id,
    market,
    openingDate: opening,
    sampleState: 'measured',
    counts: { truth, scoped: 0, naive: 0, onDisk },
    newFromNaive: Array.from({ length: naiveOnly }, (_, i) => `https://x/${id}/${i}`),
    arms,
  };
}

const arm = (label, urls, ok = true) => ({ arm: label, urls, ok });

test('armFamily groups query slots and naive pages under one family', () => {
  assert.equal(armFamily('scoped-q0'), 'scoped');
  assert.equal(armFamily('scoped-q2'), 'scoped');
  assert.equal(armFamily('naive-p1'), 'naive');
  assert.equal(armFamily('onDisk'), 'onDisk');
  assert.equal(armFamily(''), '');
});

test('classifySample: settling inside the SERP indexing window, measured after', () => {
  const settling = classifySample({ openingDate: new Date(NOW - 5 * HOUR).toISOString() }, { now: NOW });
  assert.equal(settling.state, 'settling');
  const measured = classifySample({ openingDate: new Date(NOW - 5 * DAY).toISOString() }, { now: NOW });
  assert.equal(measured.state, 'measured');
  // Boundary: exactly at the window is measured, not settling.
  const edge = classifySample({ openingDate: new Date(NOW - 24 * HOUR).toISOString() }, { now: NOW });
  assert.equal(edge.state, 'measured');
});

test('classifySample: a show with no openingDate is named, never silently dropped', () => {
  const r = classifySample({ title: 'Undated' }, { now: NOW });
  assert.equal(r.state, 'unknown-date');
  assert.match(r.reason, /openingDate/);
});

test('perArmRecall dedupes overlapping scoped queries instead of reporting recall > 1', () => {
  // All three scoped queries return the same two reviews; ground truth is 4.
  const agg = perArmRecall([row({
    truth: 4,
    arms: [
      arm('scoped-q0', ['a', 'b']),
      arm('scoped-q1', ['a', 'b']),
      arm('scoped-q2', ['a']),
      arm('naive-p0', ['a', 'b', 'c', 'd']),
    ],
  })]);
  assert.equal(agg.truthUrls, 4);
  // Per-slot recall is per-slot; the FAMILY is the union, so 2/4 not 5/4.
  assert.equal(agg.arms['scoped-q0'].recall, 0.5);
  assert.equal(agg.arms['scoped-q2'].recall, 0.25);
  assert.equal(agg.families.scoped.recall, 0.5);
  assert.equal(agg.families.naive.recall, 1);
});

test('perArmRecall pools across shows rather than averaging per show', () => {
  const agg = perArmRecall([
    row({ id: 'big', truth: 10, arms: [arm('scoped-q0', Array.from({ length: 9 }, (_, i) => `b${i}`))] }),
    row({ id: 'tiny', truth: 2, arms: [arm('scoped-q0', [])] }),
  ]);
  // Per-show mean would be (0.9 + 0)/2 = 0.45; pooled is 9/12 = 0.75.
  assert.equal(agg.truthUrls, 12);
  assert.equal(agg.families.scoped.recall, 0.75);
});

test('perArmRecall counts failed arm runs', () => {
  const agg = perArmRecall([row({
    truth: 2,
    arms: [arm('naive-p0', ['a']), { arm: 'naive-p1', urls: [], ok: false }],
  })]);
  assert.equal(agg.arms['naive-p1'].failed, 1);
  assert.equal(agg.families.naive.failed, 1);
});

test('perCategoryRecall keeps a Broadway-weighted headline from hiding a blind market', () => {
  const out = perCategoryRecall([
    row({ id: 'bw', market: 'broadway', truth: 10, arms: [arm('scoped-q0', Array.from({ length: 10 }, (_, i) => `b${i}`))] }),
    row({ id: 'owe', market: 'off-west-end', truth: 3, arms: [arm('scoped-q0', [])] }),
  ]);
  assert.equal(out.broadway.families.scoped.recall, 1);
  assert.equal(out['off-west-end'].families.scoped.recall, 0);
  assert.equal(out['off-west-end'].shows, 1);
});

test('summarizeRun excludes settling/unknown-date rows from the headline but tallies them', () => {
  const report = {
    generatedAt: '2026-08-02T12:00:00.000Z',
    naivePages: 2,
    shows: [
      row({ id: 'ok', truth: 4, arms: [arm('scoped-q0', ['a', 'b'])], onDisk: 2, naiveOnly: 1 }),
      { ...row({ id: 'fresh', truth: 99, arms: [arm('scoped-q0', [])] }), sampleState: 'settling' },
      { ...row({ id: 'nodate', truth: 99, arms: [arm('scoped-q0', [])] }), sampleState: 'unknown-date' },
    ],
  };
  const entry = summarizeRun(report);
  assert.equal(entry.date, '2026-08-02');
  assert.equal(entry.shows, 1);
  assert.equal(entry.truthUrls, 4);           // 99s excluded
  assert.deepEqual(entry.excluded, { settling: 1, 'unknown-date': 1 });
  assert.equal(entry.families.scoped, 0.5);
  assert.deepEqual(entry.sampleIds, ['ok']);
  assert.equal(entry.newFromNaive, 1);
});

// ── Regression detection ────────────────────────────────────────────────────

const entry = (date, families, truthUrls = 40) => ({ date, families, truthUrls });

test('detectRecallRegression reports blind rather than ok when there is no baseline', () => {
  assert.equal(detectRecallRegression([]).verdict, 'blind');
  assert.equal(detectRecallRegression([entry('2026-08-01', { scoped: 0.8 })]).verdict, 'blind');
});

test('detectRecallRegression: stable arms are ok', () => {
  const r = detectRecallRegression([
    entry('2026-07-12', { scoped: 0.80, naive: 0.95 }),
    entry('2026-07-19', { scoped: 0.78, naive: 0.96 }),
    entry('2026-07-26', { scoped: 0.82, naive: 0.94 }),
    entry('2026-08-02', { scoped: 0.79, naive: 0.95 }),
  ]);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.regressions.length, 0);
  assert.equal(r.comparedArms, 2);
});

test('detectRecallRegression catches ONE arm dying while its siblings cover for it', () => {
  const r = detectRecallRegression([
    entry('2026-07-12', { scoped: 0.80, naive: 0.95 }),
    entry('2026-07-19', { scoped: 0.80, naive: 0.95 }),
    entry('2026-07-26', { scoped: 0.80, naive: 0.95 }),
    entry('2026-08-02', { scoped: 0.20, naive: 0.98 }),
  ]);
  assert.equal(r.verdict, 'regressed');
  assert.equal(r.regressions.length, 1);
  assert.equal(r.regressions[0].arm, 'scoped');
  assert.equal(r.regressions[0].baseline, 0.8);
  assert.equal(r.regressions[0].current, 0.2);
});

test('detectRecallRegression treats a vanished arm as a regression, not a skip', () => {
  const r = detectRecallRegression([
    entry('2026-07-19', { scoped: 0.8, naive: 0.9 }),
    entry('2026-07-26', { scoped: 0.8, naive: 0.9 }),
    entry('2026-08-02', { naive: 0.9 }),
  ]);
  assert.equal(r.verdict, 'regressed');
  assert.equal(r.regressions[0].arm, 'scoped');
  assert.equal(r.regressions[0].current, null);
  assert.match(r.regressions[0].reason, /absent from the latest run/);
});

test('detectRecallRegression refuses to judge a run with too little ground truth', () => {
  const r = detectRecallRegression([
    entry('2026-07-19', { scoped: 0.8 }),
    entry('2026-07-26', { scoped: 0.8 }),
    entry('2026-08-02', { scoped: 0.1 }, 6),
  ]);
  assert.equal(r.verdict, 'insufficient-sample');
  assert.equal(r.regressions.length, 0);
});

test('detectRecallRegression tolerates the denominator noise a good naive week creates', () => {
  // Naive digs up long-tail blogs → truth grows → scoped recall drops a little
  // with nothing broken. Under the 0.15 threshold, that is not a regression.
  const r = detectRecallRegression([
    entry('2026-07-19', { scoped: 0.80, naive: 0.90 }),
    entry('2026-07-26', { scoped: 0.78, naive: 0.92 }),
    entry('2026-08-02', { scoped: 0.68, naive: 0.99 }),
  ]);
  assert.equal(r.verdict, 'ok');
});

test('detectRecallRegression uses a median, so one bad week cannot poison the baseline', () => {
  const r = detectRecallRegression([
    entry('2026-07-05', { scoped: 0.80 }),
    entry('2026-07-12', { scoped: 0.10 }), // provider outage week
    entry('2026-07-19', { scoped: 0.80 }),
    entry('2026-07-26', { scoped: 0.82 }),
    entry('2026-08-02', { scoped: 0.79 }),
  ]);
  assert.equal(r.verdict, 'ok');
});

// ── Provider outage ─────────────────────────────────────────────────────────

test('detectProviderOutage fires when every SERP arm returned zero raw results', () => {
  const r = detectProviderOutage([{
    counts: { truth: 3 },
    arms: [
      { arm: 'scoped-q0', raw: 0, urls: [] },
      { arm: 'naive-p0', raw: 0, urls: [] },
      { arm: 'onDisk', raw: 3, urls: ['a', 'b', 'c'] },  // filesystem, not a provider
    ],
  }]);
  assert.equal(r.outage, true);
  assert.equal(r.serpRuns, 2);
});

test('detectProviderOutage does NOT fire when results came back and were all filtered out', () => {
  // 10 raw results, none accepted (all ticketing/wrong-production). That is a
  // real recall signal, not an outage — the providers answered.
  const r = detectProviderOutage([{
    counts: { truth: 0 },
    arms: [{ arm: 'scoped-q0', raw: 10, urls: [] }, { arm: 'naive-p0', raw: 8, urls: [] }],
  }]);
  assert.equal(r.outage, false);
  assert.equal(r.productiveRuns, 2);
});

test('detectProviderOutage needs one healthy arm anywhere in the run, not per show', () => {
  const r = detectProviderOutage([
    { counts: { truth: 0 }, arms: [{ arm: 'scoped-q0', raw: 0, urls: [] }] },
    { counts: { truth: 2 }, arms: [{ arm: 'scoped-q0', raw: 9, urls: ['a', 'b'] }] },
  ]);
  assert.equal(r.outage, false);
});

test('detectProviderOutage on an empty run is not an outage', () => {
  assert.equal(detectProviderOutage([]).outage, false);
});

test('parseTrendJsonl skips a torn line instead of blinding the detector', () => {
  const recs = parseTrendJsonl('{"date":"2026-08-01"}\n{"date":"2026-08-0\n{"date":"2026-08-02"}\n\n');
  assert.deepEqual(recs.map(r => r.date), ['2026-08-01', '2026-08-02']);
});
