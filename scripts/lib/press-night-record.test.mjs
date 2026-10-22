import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./press-night-record.js');
const { censusVerdict } = require('./review-census.js');
const { deployedOutletIds } = require('./deployed-coverage-diff.js');

const EMB = '2026-10-22T02:00:00.000Z'; // 22:00 ET
const at = (min) => new Date(new Date(EMB).getTime() + min * 60000).toISOString();
const rv = (outlet, critic, extra = {}) => ({ outlet, critic, tier: 1, date: '2026-10-22', ...extra });
const fresh = () => lib.emptyRecord({ showId: 's', night: '2026-10-22', market: 'broadway', embargoAt: EMB });

test('applySample: first live, last live, counts at +1h/+2h/+6h', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A')] });
  lib.applySample(rec, { at: at(65), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  lib.applySample(rec, { at: at(125), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  lib.applySample(rec, { at: at(365), reviews: [rv('NYT', 'A'), rv('Variety', 'B'), rv('Vulture', 'C')] });
  assert.equal(rec.firstLiveAt, at(10));
  assert.equal(rec.firstLiveBaseline, false);
  assert.equal(rec.lastLiveAt, at(365));
  assert.deepEqual(rec.liveCountAt, { '1h': 2, '2h': 2, '6h': 3 });
  assert.equal(rec.perReview.find((p) => p.outlet === 'Variety').firstLiveAt, at(65));
});

test('applySample: failed fetch is counted and never read as zero live', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(1), reviews: [rv('NYT', 'A')] });
  lib.applySample(rec, { at: at(6), reviews: null });
  assert.equal(rec.probe.failedSamples, 1);
  assert.equal(rec.liveCount, 1);
  assert.equal(rec.dropped.length, 0);
});

test('applySample: a review that vanishes is recorded as dropped, restoration closes it', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(1), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  lib.applySample(rec, { at: at(6), reviews: [rv('NYT', 'A')] });
  assert.equal(rec.dropped.length, 1);
  assert.equal(rec.dropped[0].restoredAt, null);
  lib.applySample(rec, { at: at(11), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  assert.equal(rec.dropped[0].restoredAt, at(11));
});

test('applySample: reviews already live at the first sample mark the first-live time as a bound', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(20), reviews: [rv('NYT', 'A')] });
  assert.equal(rec.firstLiveBaseline, true);
});

test('firstOutletPublish: prefers exact clock times, T1/T2 only, reports approx for date-only', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(5), reviews: [rv('Blog', 'Z', { tier: 4, date: '2026-10-21T20:00:00Z' }), rv('NYT', 'A')] });
  assert.deepEqual(
    { p: rec.firstOutletPublishAt.precision, s: rec.firstOutletPublishAt.tierScope, a: rec.firstOutletPublishAt.at },
    { p: 'approx', s: 'T1-T2', a: '2026-10-22' },
  );
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A'), rv('Variety', 'B', { date: '2026-10-22T02:03:00Z' })] });
  assert.equal(rec.firstOutletPublishAt.precision, 'exact');
  assert.equal(rec.firstOutletPublishAt.at, '2026-10-22T02:03:00Z');
});

test('evaluateCheck: no record is UNKNOWN, not PASS', () => {
  const r = lib.evaluateCheck(null);
  assert.equal(r.verdict, 'UNKNOWN');
});

test('evaluateCheck: record with samples but no census is UNKNOWN even when first-live passes', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A')] });
  const r = lib.evaluateCheck(rec);
  assert.equal(r.gates.find((g) => g.name === 'first-live').status, 'pass'); // embargo bound 10 min <= 30
  assert.equal(r.gates.find((g) => g.name === 'coverage-2h').status, 'unknown');
  assert.equal(r.verdict, 'UNKNOWN');
});

test('evaluateCheck: approx publish time with a slow first review is UNKNOWN, an exact one FAILs', () => {
  const slow = fresh();
  lib.applySample(slow, { at: at(-5), reviews: [] });
  lib.applySample(slow, { at: at(104), reviews: [rv('NYT', 'A')] });
  assert.equal(lib.evaluateCheck(slow).gates.find((g) => g.name === 'first-live').status, 'unknown');
  const exact = fresh();
  lib.applySample(exact, { at: at(-5), reviews: [] });
  lib.applySample(exact, { at: at(104), reviews: [rv('NYT', 'A', { date: '2026-10-22T02:00:00Z' })] });
  assert.equal(lib.evaluateCheck(exact).gates.find((g) => g.name === 'first-live').status, 'fail');
});

test('evaluateCheck: nothing live well past the bar FAILs; nothing live inside the bar is UNKNOWN', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(10), reviews: [] });
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'unknown');
  lib.applySample(rec, { at: at(45), reviews: [] });
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'fail');
});

test('evaluateCheck: all gates met is PASS; a stuck drop FAILs; coverage under the bar FAILs', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  rec.reference['2h'] = { status: 'complete', coverage: 1, covered: 2, count: 2, missing: [] };
  assert.equal(lib.evaluateCheck(rec).verdict, 'PASS');

  rec.reference['2h'] = { status: 'incomplete', coverage: 0.5, covered: 1, count: 2, missing: ['variety'] };
  assert.equal(lib.evaluateCheck(rec, { coverage2h: 0.8 }).verdict, 'FAIL');
  assert.equal(lib.evaluateCheck(rec, { coverage2h: 0.5 }).verdict, 'PASS');

  rec.reference['2h'] = { status: 'complete', coverage: 1, covered: 2, count: 2, missing: [] };
  lib.applySample(rec, { at: at(15), reviews: [rv('NYT', 'A')] });
  const r = lib.evaluateCheck(rec);
  assert.equal(r.gates.find((g) => g.name === 'stability').status, 'fail');
  assert.equal(r.verdict, 'FAIL');
});

test('referenceFrom: empty or missing census is no-census-yet with null coverage', () => {
  const none = censusVerdict({ entries: [], count: 0, hadAnySource: false }, new Set());
  const ref = lib.referenceFrom({ census: { entries: [], count: 0, hadAnySource: false }, verdict: none, liveCount: 3, fetchedAt: 'x' });
  assert.equal(ref.status, 'no-census-yet');
  assert.equal(ref.coverage, null);
});

test('referenceFrom: real censusVerdict + deployedOutletIds give outlet-level coverage', () => {
  const census = {
    hadAnySource: true, count: 3, sourcesPresent: ['bww-roundup'],
    entries: [{ outletId: 'nytimes' }, { outletId: 'variety' }, { outletId: 'vulture' }],
  };
  const prod = { rv: [{ o: 'The New York Times', cn: 'A' }, { o: 'Variety', cn: 'B' }] };
  const covered = deployedOutletIds(prod);
  const verdict = censusVerdict(census, covered);
  const ref = lib.referenceFrom({ census, verdict, liveCount: 2, fetchedAt: 'x' });
  assert.equal(ref.count, 3);
  assert.equal(ref.covered + ref.missing.length + ref.suppressedMissing.length, 3);
  assert.ok(ref.coverage >= 0 && ref.coverage <= 1);
});

test('runProbe: samples on the interval until the deadline with an injected clock', async () => {
  const rec = fresh();
  let t = new Date(EMB).getTime();
  const calls = [];
  await lib.runProbe({
    rec,
    fetchReviews: async () => { calls.push(t); return t >= new Date(EMB).getTime() + 10 * 60000 ? [rv('NYT', 'A')] : []; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    untilMs: new Date(EMB).getTime() + 20 * 60000,
    intervalMs: 5 * 60000,
  });
  assert.equal(calls.length, 4); // +0, +5, +10, +15
  assert.equal(rec.firstLiveAt, at(10));
});

test('runProbe: a throwing fetch is a failed sample, not a crash', async () => {
  const rec = fresh();
  let t = 0;
  await lib.runProbe({
    rec, fetchReviews: async () => { throw new Error('boom'); }, now: () => t, sleep: async (ms) => { t += ms; },
    untilMs: 10 * 60000, intervalMs: 5 * 60000,
  });
  assert.equal(rec.probe.failedSamples, rec.probe.samples);
});

test('defaultEmbargoAt: Broadway 22:00 ET, West End 21:00 UK, unknown market is null', () => {
  assert.equal(lib.defaultEmbargoAt({ category: 'broadway', openingDate: '2026-10-22' }), '2026-10-23T02:00:00.000Z');
  assert.equal(lib.defaultEmbargoAt({ category: 'west-end', openingDate: '2026-10-29' }), '2026-10-29T21:00:00.000Z');
  assert.equal(lib.defaultEmbargoAt({ category: 'tour', openingDate: '2026-10-29' }), null);
});

test('runProbe: maxSamples stops without a trailing sleep', async () => {
  const rec = fresh();
  let slept = 0;
  await lib.runProbe({ rec, fetchReviews: async () => [], now: () => 0, sleep: async () => { slept += 1; }, untilMs: 1e9, intervalMs: 1000, maxSamples: 1 });
  assert.equal(rec.probe.samples, 1);
  assert.equal(slept, 0);
});

test('failed fetches never move the "waited" clock: 6h of failures after one good sample is UNKNOWN, not FAIL', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  for (let m = 0; m <= 360; m += 5) lib.applySample(rec, { at: at(m), reviews: null });
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'unknown');
});

test('baseline first-live with an exact publish time can clear the bar but never FAIL it', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(120), reviews: [rv('NYT', 'A', { date: '2026-10-22T02:00:00Z' })] });
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'unknown');
});

test('a critic label filled in mid-night is a rename, not a drop', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(1), reviews: [rv('NYT', null), rv('Variety', 'B')] });
  lib.applySample(rec, { at: at(6), reviews: [rv('NYT', 'Jesse Green'), rv('Variety', 'B')] });
  assert.equal(rec.dropped.length, 0);
  assert.equal(rec.perReview.length, 2);
  assert.equal(rec.liveCount, 2);
});

test('two same-outlet changes at once stay ambiguous: counted as a drop', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(1), reviews: [rv('NYT', 'A'), rv('NYT', 'B')] });
  lib.applySample(rec, { at: at(6), reviews: [rv('NYT', 'C'), rv('NYT', 'D')] });
  assert.equal(rec.dropped.length, 2);
});

test('liveCountAt: a sample long after the mark is not recorded as the count at that mark', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(30), reviews: [rv('NYT', 'A')] });
  lib.applySample(rec, { at: at(400), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  assert.equal(rec.liveCountAt['1h'], null);
  assert.equal(rec.liveCountSampleAt['1h'], at(400));
  assert.equal(rec.liveCountAt['6h'], null);
});

test('coverage-2h: a census captured nowhere near +2h is UNKNOWN', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A')] });
  rec.reference['2h'] = { status: 'complete', coverage: 1, covered: 1, count: 1, missing: [], fetchedAt: at(300) };
  assert.equal(lib.evaluateCheck(rec).gates.find((g) => g.name === 'coverage-2h').status, 'unknown');
  rec.reference['2h'].fetchedAt = at(122);
  assert.equal(lib.evaluateCheck(rec).gates.find((g) => g.name === 'coverage-2h').status, 'pass');
});

test('probeDue: window is embargo-2.5h .. embargo+3h on the opening day only; tours never', () => {
  const show = { id: 'x', category: 'broadway', openingDate: '2026-10-22' }; // embargo 2026-10-23T02:00Z
  const emb = new Date('2026-10-23T02:00:00Z').getTime();
  assert.equal(lib.probeDue(show, emb - 3 * 3600000), null); // before the window
  assert.deepEqual(lib.probeDue(show, emb - 90 * 60000), { showId: 'x', night: '2026-10-22', market: 'broadway', embargoAt: '2026-10-23T02:00:00.000Z' });
  assert.ok(lib.probeDue(show, emb + 30 * 60000));
  assert.ok(lib.probeDue(show, emb + 90 * 60000));
  assert.equal(lib.probeDue(show, emb + 4 * 3600000), null);
  assert.equal(lib.probeDue({ ...show, category: 'tour' }, emb), null);
  assert.equal(lib.probeDue({ id: 'y', category: 'broadway' }, emb), null);
});
