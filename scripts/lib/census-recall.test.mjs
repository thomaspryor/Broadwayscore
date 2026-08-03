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

// Entries carry familyYield (URLs/show) because the detector requires BOTH
// recall AND absolute yield to fall before it alerts. Default yield tracks
// recall so existing scenarios behave as their names say.
const entry = (date, families, truthUrls = 40, familyYield = null) => ({
  date,
  families,
  truthUrls,
  familyYield: familyYield || Object.fromEntries(Object.entries(families).map(([k, v]) => [k, v * 8])),
});

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

// ── Fixes from ship-check (2026-08-02) ──────────────────────────────────────

test('a good week for one arm does not report the others as regressed (denominator inflation)', () => {
  // The scoped arm finds the SAME URLs every week; one deep naive week grows
  // ground truth 40 -> 70, mechanically cutting scoped recall from 0.80 to
  // 0.457. Reproduced as a false positive before the yield-corroboration rule.
  const flatYield = { scoped: 32, naive: 30 };
  const r = detectRecallRegression([
    { date: '2026-07-12', families: { scoped: 0.8, naive: 0.75 }, truthUrls: 40, familyYield: flatYield },
    { date: '2026-07-19', families: { scoped: 0.8, naive: 0.75 }, truthUrls: 40, familyYield: flatYield },
    { date: '2026-07-26', families: { scoped: 0.8, naive: 0.75 }, truthUrls: 40, familyYield: flatYield },
    { date: '2026-08-02', families: { scoped: 0.457, naive: 0.95 }, truthUrls: 70, familyYield: { scoped: 32, naive: 66 } },
  ]);
  assert.equal(r.verdict, 'ok', r.reason);
});

test('a real arm death still fires when its absolute yield collapses too', () => {
  const r = detectRecallRegression([
    { date: '2026-07-12', families: { scoped: 0.8 }, truthUrls: 40, familyYield: { scoped: 32 } },
    { date: '2026-07-19', families: { scoped: 0.8 }, truthUrls: 40, familyYield: { scoped: 32 } },
    { date: '2026-07-26', families: { scoped: 0.8 }, truthUrls: 40, familyYield: { scoped: 32 } },
    { date: '2026-08-02', families: { scoped: 0.1 }, truthUrls: 40, familyYield: { scoped: 4 } },
  ]);
  assert.equal(r.verdict, 'regressed');
  assert.equal(r.regressions[0].rule, 'week-on-week');
});

test('a slow decline that never trips week-on-week is caught by the drift rule', () => {
  // 0.05/week for 10 weeks: 0.80 -> 0.30. The sliding median follows it down,
  // so no single week ever clears 0.15 — verified silent before this rule.
  const entries = [];
  for (let i = 0; i < 11; i += 1) {
    const recall = Math.round((0.8 - i * 0.05) * 1000) / 1000;
    entries.push({
      date: `2026-05-${String(3 + i).padStart(2, '0')}`,
      families: { scoped: recall },
      truthUrls: 40,
      familyYield: { scoped: recall * 40 },
    });
  }
  const r = detectRecallRegression(entries);
  assert.equal(r.verdict, 'regressed', r.reason);
  assert.equal(r.regressions[0].rule, 'slow-drift');
});

test('one query slot dying is caught even while its family stays inside the threshold', () => {
  // scoped-q0 collapses 0.5 -> 0.02; q1/q2 pick up the slack so the FAMILY
  // only moves 0.80 -> 0.72, under the 0.15 week-on-week threshold. Judging
  // families alone reported a clean pass.
  const base = (q0, q1, fam) => ({
    families: { scoped: fam },
    familyYield: { scoped: fam * 40 },
    arms: { 'scoped-q0': q0, 'scoped-q1': q1 },
    armYield: { 'scoped-q0': q0 * 40, 'scoped-q1': q1 * 40 },
    truthUrls: 40,
  });
  const r = detectRecallRegression([
    { date: '2026-07-12', ...base(0.5, 0.45, 0.8) },
    { date: '2026-07-19', ...base(0.5, 0.45, 0.8) },
    { date: '2026-07-26', ...base(0.5, 0.45, 0.8) },
    { date: '2026-08-02', ...base(0.02, 0.70, 0.72) },
  ]);
  assert.equal(r.verdict, 'regressed', r.reason);
  assert.ok(r.regressions.some(x => x.arm === 'scoped-q0' && x.level === 'arms'), JSON.stringify(r.regressions));
});

test('an arm whose input was unavailable is skipped, not reported as collapsed', () => {
  // A failed review-texts checkout zeroes onDisk for infrastructure reasons.
  const mk = (onDisk, unavailable) => ({
    families: { scoped: 0.8, onDisk: onDisk },
    familyYield: { scoped: 32, onDisk: onDisk * 40 },
    truthUrls: 40,
    unavailableArms: unavailable,
  });
  const r = detectRecallRegression([
    { date: '2026-07-19', ...mk(0.9, []) },
    { date: '2026-07-26', ...mk(0.9, []) },
    { date: '2026-08-02', ...mk(0, ['onDisk']) },
  ]);
  assert.equal(r.verdict, 'ok', r.reason);
  assert.ok(r.skipped.some(s => s.startsWith('onDisk')), JSON.stringify(r.skipped));
});

test('the same arm WITHOUT the unavailable marker is still reported as collapsed', () => {
  const mk = (onDisk) => ({
    families: { scoped: 0.8, onDisk },
    familyYield: { scoped: 32, onDisk: onDisk * 40 },
    truthUrls: 40,
  });
  const r = detectRecallRegression([
    { date: '2026-07-19', ...mk(0.9) },
    { date: '2026-07-26', ...mk(0.9) },
    { date: '2026-08-02', ...mk(0) },
  ]);
  assert.equal(r.verdict, 'regressed');
  assert.ok(r.regressions.some(x => x.arm === 'onDisk'));
});

test('detectProviderOutage fires on a PARTIAL outage, not just a total one', () => {
  // 2 of 9 queries answered — a cap hit partway through. Numerically that run
  // is mostly fiction, but a zero-test would have let it into the baseline.
  const arms = [];
  for (let i = 0; i < 9; i += 1) arms.push({ arm: `naive-p${i}`, raw: i < 2 ? 7 : 0, urls: [] });
  const r = detectProviderOutage([{ counts: { truth: 2 }, arms }]);
  assert.equal(r.outage, true);
  assert.equal(r.productiveRuns, 2);
});

test('detectProviderOutage stays quiet when most queries answered', () => {
  const arms = [];
  for (let i = 0; i < 9; i += 1) arms.push({ arm: `naive-p${i}`, raw: i < 6 ? 7 : 0, urls: [] });
  assert.equal(detectProviderOutage([{ counts: { truth: 9 }, arms }]).outage, false);
});

test('summarizeRun records per-show yield and the unavailable-arm marker', () => {
  const e = summarizeRun({
    generatedAt: '2026-08-02T12:00:00.000Z',
    shows: [
      row({ id: 'a', truth: 4, arms: [arm('scoped-q0', ['a', 'b']), arm('onDisk', [])] }),
      row({ id: 'b', truth: 6, arms: [arm('scoped-q0', ['c', 'd', 'e']), arm('onDisk', [])] }),
    ],
  }, { unavailableArms: ['onDisk'] });
  assert.equal(e.truthUrls, 10);
  assert.equal(e.familyYield.scoped, 2.5); // 5 URLs over 2 shows
  assert.deepEqual(e.unavailableArms, ['onDisk']);
});

// ── Trend-ledger union merge (task #784's race class) ───────────────────────

const { mergeCensusRecallTrend } = require('./merge-census-recall-trend.js');
const { mergerFor } = require('./reconcile-merged-json.js');

test('the trend ledger is registered with the post-rebase reconciler', () => {
  // Without this registration, `rebase -X theirs` silently drops a concurrent
  // writer's line with no conflict reported — exactly task #784.
  assert.ok(mergerFor('data/audit/census-recall-trend.jsonl'), 'not in the MANAGED registry');
});

test('merging keeps the better-evidenced entry for a shared date and unions the rest', () => {
  const r = mergeCensusRecallTrend(
    [{ date: '2026-07-26', truthUrls: 100 }, { date: '2026-08-02', truthUrls: 120 }],
    [{ date: '2026-07-26', truthUrls: 40 }, { date: '2026-08-09', truthUrls: 90 }],
  );
  assert.deepEqual(r.merged.map(e => e.date), ['2026-07-26', '2026-08-02', '2026-08-09']);
  assert.equal(r.merged.find(e => e.date === '2026-07-26').truthUrls, 100);
  assert.equal(r.stats.added, 1);
});

test('a remote entry with MORE ground truth wins the shared date', () => {
  const r = mergeCensusRecallTrend(
    [{ date: '2026-08-02', truthUrls: 20 }],
    [{ date: '2026-08-02', truthUrls: 200 }],
  );
  assert.equal(r.merged[0].truthUrls, 200);
  assert.equal(r.stats.replaced, 1);
});

test('merging is idempotent — re-merging the same sides changes nothing', () => {
  const ours = [{ date: '2026-08-02', truthUrls: 20 }];
  const remote = [{ date: '2026-08-02', truthUrls: 20 }];
  const once = mergeCensusRecallTrend(ours, remote).merged;
  const twice = mergeCensusRecallTrend(once, remote).merged;
  assert.deepEqual(twice, once);
});

// ── combinedRecall (ported from the parallel #901 implementation) ───────────

test('combinedRecall unions the scoped arms with what is already on disk', () => {
  const agg = perArmRecall([row({
    truth: 10,
    arms: [
      arm('scoped-q0', ['a', 'b']),
      arm('onDisk', ['b', 'c', 'd']),
      arm('naive-p0', ['e', 'f', 'g', 'h', 'i', 'j']),
    ],
  })]);
  assert.equal(agg.combinedRecall, 0.4); // a,b,c,d — naive excluded, b not double-counted
  assert.equal(agg.families.naive.recall, 0.6);
});

test('summarizeRun carries combinedRecall into the trend entry', () => {
  const e = summarizeRun({
    generatedAt: '2026-08-03T12:00:00.000Z',
    shows: [row({ truth: 4, arms: [arm('scoped-q0', ['a']), arm('onDisk', ['b'])] })],
  });
  assert.equal(e.combinedRecall, 0.5);
});
