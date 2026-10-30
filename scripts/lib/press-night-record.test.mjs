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
  lib.applySample(exact, { at: at(99), reviews: [] });
  lib.applySample(exact, { at: at(104), reviews: [rv('NYT', 'A', { date: '2026-10-22T02:00:00Z' })] });
  assert.equal(lib.evaluateCheck(exact).gates.find((g) => g.name === 'first-live').status, 'fail');
  // A 109-min sampling gap before the first sighting: it may have gone live early, so not a FAIL.
  const gap = fresh();
  lib.applySample(gap, { at: at(-5), reviews: [] });
  lib.applySample(gap, { at: at(104), reviews: [rv('NYT', 'A', { date: '2026-10-22T02:00:00Z' })] });
  assert.equal(lib.evaluateCheck(gap).gates.find((g) => g.name === 'first-live').status, 'unknown');
});

test('evaluateCheck: nothing live well past the bar FAILs; nothing live inside the bar is UNKNOWN', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(10), reviews: [] });
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'unknown');
  lib.applySample(rec, { at: at(45), reviews: [] });
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'unknown'); // no evidence any outlet published
  rec.reference.end = { status: 'incomplete', count: 3, coverage: 0, covered: 0, missing: ['a', 'b', 'c'] };
  assert.equal(lib.evaluateCheck(rec).gates[0].status, 'fail');
});

test('evaluateCheck: all gates met is PASS; a stuck drop FAILs; coverage under the bar FAILs', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A'), rv('Variety', 'B')] });
  rec.reference['2h'] = { status: 'complete', coverage: 1, covered: 2, count: 2, missing: [] };
  assert.equal(lib.evaluateCheck(rec).verdict, 'UNKNOWN'); // BRO-6070: no review-file snapshot, so same-night-completeness is unknown
  rec.fileState = { files: [] };
  assert.equal(lib.evaluateCheck(rec).verdict, 'PASS');

  rec.reference['2h'] = { status: 'incomplete', coverage: 0.5, covered: 1, count: 2, missing: ['variety'] };
  assert.equal(lib.evaluateCheck(rec, { coverage2h: 0.8 }).verdict, 'FAIL');
  // The 0.8 bar is met at 0.5 here, but same-night-completeness still names the missing listed outlet.
  const lenient = lib.evaluateCheck(rec, { coverage2h: 0.5 });
  assert.equal(lenient.gates.find((g) => g.name === 'coverage-2h').status, 'pass');
  assert.equal(lenient.gates.find((g) => g.name === 'same-night-completeness').status, 'fail');
  assert.equal(lenient.verdict, 'FAIL');

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

// BRO-6067: a preview-period review live before the night must not erase the first-live baseline.
const previewThenBulk = () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(21), reviews: [rv('singleticket', null, { tier: 3, date: '2026-10-05' })] });
  lib.applySample(rec, { at: at(82), reviews: [rv('singleticket', null, { tier: 3, date: '2026-10-05' })] });
  lib.applySample(rec, { at: at(87), reviews: [rv('singleticket', null, { tier: 3, date: '2026-10-05' }), rv('Deadline', 'Greg Evans'), rv('Variety', 'B')] });
  return rec;
};

test('first-live ignores a preview-period review that was live at the first sample', () => {
  const rec = previewThenBulk();
  const fl = lib.firstNightLive(rec);
  assert.equal(fl.at, at(87));
  assert.equal(fl.baseline, false);
  const g = lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live');
  assert.equal(g.status, 'unknown'); // date-only publish, no lane discovery: still cannot bound publish-to-live
  assert.match(g.detail, /87 min after the embargo \(bar 30\)/);
  assert.doesNotMatch(g.detail, /already live at the first sample/);
});

test('first-live: a lane-shadow discovery bounds the publish time, so a slow night FAILs with a number', () => {
  const rec = previewThenBulk();
  rec.laneShadow = lib.laneShadowFrom({
    report: { startedAt: at(-140) },
    liveRows: [{ outlet: 'singleticket', at: Date.parse(at(-140)) }, { outlet: 'Deadline', at: Date.parse(at(88)) }],
    ledgerRows: [{ stage: 'discovered', at: at(4), reviewKey: 'https://deadline.com/x', meta: { url: 'https://deadline.com/x' } }],
  });
  const g = lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live');
  assert.equal(g.status, 'fail');
  assert.match(g.detail, /78-87 min after the first outlet publish/);
});

test('first-live: a fast night PASSes on the embargo bound even with a preview review live early', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-30), reviews: [rv('singleticket', null, { tier: 3, date: '2026-10-05' })] });
  lib.applySample(rec, { at: at(12), reviews: [rv('singleticket', null, { tier: 3, date: '2026-10-05' }), rv('NYT', 'A')] });
  assert.equal(lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live').status, 'pass');
});

test('coverageAt: +2h coverage from the live timeline against a later census', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(60), reviews: [rv('The New York Times', 'A'), rv('New York Daily News', 'C')] });
  lib.applySample(rec, { at: at(70), reviews: [rv('The New York Times', 'A')] }); // Daily News dropped
  lib.applySample(rec, { at: at(200), reviews: [rv('The New York Times', 'A'), rv('Vulture', 'V')] });
  const census = { hadAnySource: true, count: 4, sourcesPresent: ['bww-roundup-live'],
    entries: [{ outletId: 'nytimes' }, { outletId: 'nydailynews' }, { outletId: 'vulture' }, { outletId: 'variety' }] };
  // Variety first found after +2h: listed, but kept in the denominator (discovery only bounds publish from above).
  // The shadow saw the Daily News at +65 but the probe saw it dropped at +70, so it stays missing.
  rec.laneShadow = { liveFirstSeen: [{ outlet: 'New York Daily News', at: at(65) }], discoveredByOutlet: { variety: at(150) } };
  const ref = lib.coverageAt(rec, census, Date.parse(at(120)), { fetchedAt: at(600) });
  assert.equal(ref.method, 'timeline');
  assert.equal(ref.asOf, at(120));
  assert.deepEqual(ref.discoveredAfter, ['variety']);
  assert.equal(ref.count, 4);
  assert.deepEqual(ref.missing.sort(), ['nydailynews', 'variety', 'vulture']);
  rec.reference['2h'] = ref;
  const g = lib.evaluateCheck(rec).gates.find((x) => x.name === 'coverage-2h');
  assert.equal(g.status, 'fail'); // 1/4, and judged as of +2h even though fetched at +10h
  assert.match(g.detail, /1\/4 census outlets live at \+2h/);
});

test('coverageAt: a shadow sighting before the probe saw the outlet counts', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(125), reviews: [rv('Vulture', 'V')] }); // probe gap until +125
  rec.laneShadow = { liveFirstSeen: [{ outlet: 'Vulture', at: at(110) }] };
  const census = { hadAnySource: true, count: 1, sourcesPresent: ['bww-roundup-live'], entries: [{ outletId: 'vulture' }] };
  assert.equal(lib.coverageAt(rec, census, Date.parse(at(120))).coverage, 1);
});

test('first-live: failed polls before the first sighting leave no made-up lower bound', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  for (let m = 5; m <= 80; m += 5) lib.applySample(rec, { at: at(m), reviews: null });
  lib.applySample(rec, { at: at(85), reviews: [rv('Deadline', 'G')] });
  assert.equal(rec.perReview[0].prevOkSampleAt, at(-5));
  rec.laneShadow = { liveFirstSeen: [], firstDiscoveredAt: at(3) };
  const g = lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live');
  assert.equal(g.status, 'unknown'); // live somewhere in (-5, 85]: could have been within the bar
  assert.match(g.detail, /0-85 min/);
});

test('laneShadowFrom: earliest discovery, BWW roundup url, per-outlet first discovery', () => {
  const ls = lib.laneShadowFrom({
    report: { startedAt: Date.parse(at(-140)) },
    liveRows: [{ outlet: 'Deadline', url: 'https://deadline.com/x', at: Date.parse(at(87)) }],
    ledgerRows: [
      { stage: 'discovered', at: at(80), reviewKey: 'https://www.nytimes.com/r', meta: { adapter: 'bww-roundup', via: 'https://www.broadwayworld.com/article/Review-Roundup-X', url: 'https://www.nytimes.com/r' } },
      { stage: 'discovered', at: at(4), reviewKey: 'https://deadline.com/x', meta: { url: 'https://deadline.com/x' } },
      { stage: 'scored', at: at(1), reviewKey: 'https://deadline.com/x' },
    ],
  });
  assert.equal(ls.firstDiscoveredAt, at(4));
  assert.equal(ls.bwwRoundupUrl, 'https://www.broadwayworld.com/article/Review-Roundup-X');
  assert.equal(ls.discoveredByOutlet.nytimes, at(80));
  assert.equal(ls.liveFirstSeen[0].baseline, false);
});

test('the committed Imaginary Invalid 2026-10-22 record answers first-live and coverage-2h with numbers', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'audit', 'press-night', 'the-imaginary-invalid-2026-2026-10-22.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gates = Object.fromEntries(lib.evaluateCheck(rec).gates.map((g) => [g.name, g]));
  assert.notEqual(gates['first-live'].status, 'unknown', gates['first-live'].detail);
  assert.match(gates['first-live'].detail, /\d+(-\d+)? min after/);
  assert.notEqual(gates['coverage-2h'].status, 'unknown', gates['coverage-2h'].detail);
  assert.match(gates['coverage-2h'].detail, /bww-roundup/);
});

test('first-live: a late exact publish time does not hide an earlier lane discovery', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(82), reviews: [] });
  lib.applySample(rec, { at: at(87), reviews: [rv('NYT', 'A', { date: at(80) })] });
  rec.firstOutletPublishAt = lib.firstOutletPublish(rec);
  assert.equal(rec.firstOutletPublishAt.precision, 'exact');
  rec.laneShadow = { liveFirstSeen: [], firstDiscoveredAt: at(4) };
  assert.equal(lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live').status, 'fail');
  rec.laneShadow = null; // without the discovery the first publish could be as late as +80: not provably slow
  assert.equal(lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live').status, 'unknown');
});

test('firstOutletPublish compares instants, not strings, across offsets', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(30), reviews: [rv('NYT', 'A', { date: '2026-10-22T22:05:00-04:00' }), rv('Variety', 'B', { date: '2026-10-23T02:03:00Z' })] });
  assert.equal(rec.firstOutletPublishAt.at, '2026-10-23T02:03:00Z');
});

test('first-live: a lane discovery well before the assumed embargo never PASSes (the embargo is wrong)', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'A')] });
  const fl = () => lib.evaluateCheck(rec).gates.find((x) => x.name === 'first-live');
  assert.equal(fl().status, 'pass'); // 10 min after the embargo
  rec.laneShadow = { liveFirstSeen: [], firstDiscoveredAt: at(-90) };
  assert.equal(fl().status, 'unknown');
  assert.match(fl().detail, /before the assumed embargo/);
  rec.laneShadow = { liveFirstSeen: [], firstDiscoveredAt: at(-20) }; // clock skew within 30 min: still judged
  assert.equal(fl().status, 'pass');
});

test('first-live: with an exact publish, an early lane discovery still blocks PASS but keeps a sound FAIL', () => {
  const quick = fresh();
  lib.applySample(quick, { at: at(-5), reviews: [] });
  lib.applySample(quick, { at: at(15), reviews: [rv('NYT', 'A', { date: at(5) })] });
  quick.firstOutletPublishAt = lib.firstOutletPublish(quick);
  const fl = (r) => lib.evaluateCheck(r).gates.find((x) => x.name === 'first-live').status;
  assert.equal(fl(quick), 'pass');
  quick.laneShadow = { liveFirstSeen: [], firstDiscoveredAt: at(-90) };
  assert.equal(fl(quick), 'unknown');
  const slow = fresh();
  lib.applySample(slow, { at: at(-5), reviews: [] });
  lib.applySample(slow, { at: at(82), reviews: [] });
  lib.applySample(slow, { at: at(87), reviews: [rv('NYT', 'A', { date: at(5) })] });
  slow.firstOutletPublishAt = lib.firstOutletPublish(slow);
  slow.laneShadow = { liveFirstSeen: [], firstDiscoveredAt: at(-90) };
  assert.equal(fl(slow), 'fail'); // the first publish was no later than the exact +5, so at least 77 min
});

// ---- BRO-6070: census exclusions and same-night-completeness ----

const file = (outletId, firstMin, extra = {}) => ({ outletId, critic: 'C', firstSeenAt: at(firstMin), includable: true, reason: null, syndicatedUnder: null, ...extra });
// rec: reviews go live at the given minutes (outlet display name -> minute); probe covers -5..400.
function nightRec(liveAtMin, files, { census = true, excluded = [] } = {}) {
  const r = fresh();
  const names = Object.keys(liveAtMin);
  for (let m = -5; m <= 400; m += 5) {
    lib.applySample(r, { at: at(m), reviews: names.filter((n) => liveAtMin[n] <= m).map((n) => rv(n, `crit-${n}`)) });
  }
  r.fileState = files ? { capturedAt: at(500), files } : undefined;
  if (census) r.reference = { '2h': { status: 'complete', source: ['dtli'], count: names.length, covered: names.length, coverage: 1, missing: [], asOf: at(120), fetchedAt: at(500), method: 'timeline', ...(excluded.length ? { excluded } : {}) } };
  return r;
}
const sn = (r, o) => lib.evaluateCheck(r, o).gates.find((g) => g.name === 'same-night-completeness');

test('filterCensus drops excluded outlets from the denominator; coverageAt no longer counts them missing', () => {
  const census = { entries: [{ outletId: 'nytimes' }, { outletId: 'cititour' }, { outletId: 'nydailynews' }], count: 3, sourcesPresent: ['dtli'], hadAnySource: true };
  const rec = nightRec({ 'The New York Times': 10 }, null, { census: false });
  const raw = lib.coverageAt(rec, census, new Date(at(120)).getTime());
  assert.deepEqual(raw.missing.sort(), ['cititour', 'nydailynews']);
  const excluded = [{ outletId: 'cititour', reason: 'wrongProduction' }, { outletId: 'nydailynews', reason: 'syndicated copy' }];
  const ref = lib.coverageAt(rec, census, new Date(at(120)).getTime(), { excluded });
  assert.equal(ref.count, 1);
  assert.equal(ref.coverage, 1);
  assert.deepEqual(ref.missing, []);
  assert.deepEqual(ref.excluded, excluded);
});

test('same-night-completeness passes when everything listed and every night file is live in time', () => {
  const r = nightRec({ 'The New York Times': 10, Vulture: 125 }, [file('nytimes', 5), file('vulture', 122)]);
  assert.equal(sn(r).status, 'pass', sn(r).detail);
});

test('same-night-completeness fails (a) and names an outlet whose file existed by +2h but went live after it', () => {
  const r = nightRec({ 'The New York Times': 10, 'Talkin\' Broadway': 150 }, [file('nytimes', 5), file('talkinbroadway', 20)]);
  const g = sn(r);
  assert.equal(g.status, 'fail');
  assert.match(g.detail, /talkinbroadway \(review first seen 02:20Z|talkinbroadway \(review first seen/);
  assert.match(g.detail, /after \+2h/);
});

test('same-night-completeness fails (b) for a late-night review live more than 30 min after first seen, passes within 30', () => {
  const late = nightRec({ 'The New York Times': 10, Vulture: 170 }, [file('nytimes', 5), file('vulture', 125)]);
  assert.equal(sn(late).status, 'fail');
  assert.match(sn(late).detail, /vulture .*45 min later/);
  const ok = nightRec({ 'The New York Times': 10, Vulture: 150 }, [file('nytimes', 5), file('vulture', 125)]);
  assert.equal(sn(ok).status, 'pass', sn(ok).detail);
  assert.equal(sn(ok, { lateLiveWithinMin: 20 }).status, 'fail');
});

test('same-night-completeness: a late review that never went live is named once the probe ran past the bar', () => {
  const r = nightRec({ 'The New York Times': 10 }, [file('nytimes', 5), file('vulture', 125)]);
  assert.equal(sn(r).status, 'fail');
  assert.match(sn(r).detail, /vulture .*never live/);
});

test('same-night-completeness ignores excluded files and files outside the night window', () => {
  const r = nightRec({ 'The New York Times': 10 }, [
    file('nytimes', 5),
    file('cititour', 20, { includable: false, reason: 'wrongProduction' }),
    file('nydailynews', 20, { includable: false, reason: 'knownSyndicationSecondary', syndicatedUnder: 'chicagotribune' }),
    file('oldoutlet', -60 * 24 * 30), // first seen a month ago
  ]);
  assert.equal(sn(r).status, 'pass', sn(r).detail);
});

test('same-night-completeness is unknown without a file snapshot or without a census, never pass', () => {
  assert.equal(sn(nightRec({ 'The New York Times': 10 }, null)).status, 'unknown');
  assert.match(sn(nightRec({ 'The New York Times': 10 }, null)).detail, /no review-file snapshot/);
  assert.equal(sn(nightRec({ 'The New York Times': 10 }, [file('nytimes', 5)], { census: false })).status, 'unknown');
  assert.equal(lib.evaluateCheck(nightRec({ 'The New York Times': 10 }, null)).verdict, 'UNKNOWN');
});

test('same-night-completeness: census outlets still missing at +2h are named even with no file for them', () => {
  const r = nightRec({ 'The New York Times': 10 }, [file('nytimes', 5)]);
  r.reference['2h'].missing = ['deadline'];
  r.reference['2h'].covered = 0;
  r.reference['2h'].coverage = 0.5;
  assert.equal(sn(r).status, 'fail');
  assert.match(sn(r).detail, /deadline \(listed by the aggregators, not live at \+2h\)/);
});

test('stability does not count the drop of a review the rebuild excludes, but still counts a real one', () => {
  const r = fresh();
  lib.applySample(r, { at: at(5), reviews: [rv('New York Daily News', 'Chris Jones'), rv('Vulture', 'S')] });
  lib.applySample(r, { at: at(10), reviews: [rv('Vulture', 'S')] });
  const stab = (x) => lib.evaluateCheck(x).gates.find((g) => g.name === 'stability');
  assert.equal(stab(r).status, 'fail'); // no snapshot: cannot prove the exclusion
  r.fileState = { files: [file('nydailynews', 0, { includable: false, reason: 'knownSyndicationSecondary' }), file('vulture', 0)] };
  assert.equal(stab(r).status, 'pass');
  assert.match(stab(r).detail, /New York Daily News/);
  lib.applySample(r, { at: at(15), reviews: [] }); // Vulture (includable) now drops too
  assert.equal(stab(r).status, 'fail');
});

test('the committed 2026-10-22 record: exclusions applied, same-night gate names Talkin\' Broadway and Vulture', () => {
  const fs = require('fs');
  const path = require('path');
  const f = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'audit', 'press-night', 'the-imaginary-invalid-2026-2026-10-22.json');
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ref2 = rec.reference['2h'];
  assert.ok(!ref2.missing.includes('cititour') && !ref2.missing.includes('nydailynews'), `still missing: ${ref2.missing}`);
  assert.deepEqual(ref2.excluded.map((x) => x.outletId).sort(), ['cititour', 'nydailynews']);
  const g = lib.evaluateCheck(rec).gates.find((x) => x.name === 'same-night-completeness');
  assert.equal(g.status, 'fail');
  assert.match(g.detail, /talkinbroadway/);
  assert.match(g.detail, /vulture/);
});

test('same-night-completeness matches by critic: one live review does not vouch for a second critic at the same outlet', () => {
  const r = nightRec({ 'New York Stage Review': 10 }, [file('nysr', 5, { critic: 'New York Stage Review' }), file('nysr', 6, { critic: 'Someone Else' })]);
  r.perReview[0].critic = 'New York Stage Review';
  const g = sn(r);
  assert.equal(g.status, 'fail', g.detail);
  assert.match(g.detail, /nysr/);
});

test('same-night-completeness ignores preview-period (non-night) live rows as proof', () => {
  const r = nightRec({ singleticket: 10 }, [file('singleticket', 5)]);
  r.perReview[0].baseline = true;
  r.perReview[0].publishAt = '2026-10-05';
  assert.equal(sn(r).status, 'fail');
});

test('same-night-completeness is unknown when the snapshot predates embargo +3h +30 min, but a named miss still fails', () => {
  const r = nightRec({ 'The New York Times': 10 }, [file('nytimes', 5)]);
  r.fileState.capturedAt = at(130);
  assert.equal(sn(r).status, 'unknown');
  assert.match(sn(r).detail, /snapshot was taken/);
  r.reference['2h'].missing = ['deadline'];
  assert.equal(sn(r).status, 'fail');
});

test('same-night-completeness: a file first seen just before +2h gets the late-branch latency, not a hard +2h line', () => {
  const ok = nightRec({ Vulture: 125 }, [file('vulture', 119)]);
  assert.equal(sn(ok).status, 'pass', sn(ok).detail);
  const late = nightRec({ Vulture: 160 }, [file('vulture', 119)]);
  assert.equal(sn(late).status, 'fail');
});

test('readReviewFileState: a file with no outlet gets no outlet id rather than "unknown"', () => {
  const state = require('./press-night-review-state.js');
  assert.equal(state.outletIdOfFile({}), null);
});

test('outletLiveMs matches critics across diacritics (Zoë and Zoe are one critic)', () => {
  const rec = fresh();
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [rv('NYT', 'Zoë Smith')] });
  const { byCritic } = lib.outletLiveMs(rec);
  const keys = [...(byCritic instanceof Map ? byCritic.keys() : Object.keys(byCritic))];
  assert.ok(keys.some((k) => k.endsWith('|zoesmith')), JSON.stringify(keys));
  assert.ok(!keys.some((k) => k.endsWith('|zosmith')));
});

// BRO-6079
const stateLib = require('./press-night-review-state.js');
const winStartMs = Date.parse(EMB) - lib.DEFAULT_GATES.nightStartH * 3600000;

test('censusExclusions: pre-night excluded files cannot drop an outlet from the denominator (A Few Good Men shape)', () => {
  const census = { entries: [{ outletId: 'variety' }, { outletId: 'deadline' }, { outletId: 'nytimes' }], count: 3, sourcesPresent: ['dtli'], hadAnySource: true };
  const junk = (outletId, reason) => ({ outletId, firstSeenAt: '2026-06-10T12:00:00.000Z', publishDate: '2026-06-10', includable: false, reason, syndicatedUnder: null });
  const files = [junk('deadline', 'wrongProduction'), junk('variety', 'rejectionReason')];
  // legacy (no window): the bug, both silently dropped
  assert.deepEqual(stateLib.censusExclusions(census, files).map((e) => e.outletId).sort(), ['deadline', 'variety']);
  const opts = { windowStartMs: winStartMs, night: '2026-10-22' };
  const excluded = stateLib.censusExclusions(census, files, opts);
  assert.deepEqual(excluded, []);
  // night-window junk still excludes; so does a night-published file with no firstSeenAt
  assert.deepEqual(stateLib.censusExclusions(census, [{ ...junk('deadline', 'nonReview'), firstSeenAt: at(30) }], opts).map((e) => e.outletId), ['deadline']);
  assert.deepEqual(stateLib.censusExclusions(census, [{ ...junk('variety', 'nonReview'), firstSeenAt: null, publishDate: '2026-10-22' }], opts).map((e) => e.outletId), ['variety']);
  // end to end: neither live -> coverage-2h FAIL naming both
  const r = nightRec({ 'The New York Times': 10 }, files);
  r.reference['2h'] = lib.coverageAt(r, census, Date.parse(at(120)), { excluded });
  const g = lib.evaluateCheck(r).gates.find((x) => x.name === 'coverage-2h');
  assert.equal(g.status, 'fail');
  assert.match(g.detail, /variety/);
  assert.match(g.detail, /deadline/);
});

test('coverageAt deferLateSeen: a review first seen at +3h is graded by the 30-min rule, not the +2h bar', () => {
  const census = { entries: [{ outletId: 'nytimes' }, { outletId: 'vulture' }, { outletId: 'variety' }], count: 3, sourcesPresent: ['dtli'], hadAnySource: true };
  const files = [file('nytimes', 5), file('vulture', 180)];
  const r = nightRec({ 'The New York Times': 10, Vulture: 185 }, files, { census: false });
  const at2h = Date.parse(at(120));
  const strict = lib.coverageAt(r, census, at2h);
  assert.deepEqual(strict.missing.sort(), ['variety', 'vulture']);
  const ref = lib.coverageAt(r, census, at2h, { deferLateSeen: true });
  // vulture deferred; variety has no file at all so it stays missing
  assert.deepEqual(ref.missing, ['variety']);
  assert.equal(ref.count, 2);
  // same-night: vulture first seen +3h... outside +2h so (b) applies, live within 30 min -> no miss named
  const r2 = nightRec({ 'The New York Times': 10, Vulture: 185 }, files, { census: false });
  r2.reference = { '2h': lib.coverageAt(r2, { entries: [{ outletId: 'nytimes' }, { outletId: 'vulture' }], count: 2, sourcesPresent: ['dtli'], hadAnySource: true }, at2h, { deferLateSeen: true }) };
  assert.equal(r2.reference['2h'].coverage, 1);
  assert.equal(sn(r2).status, 'pass', sn(r2).detail);
  // a deferred review that goes live too late still FAILs under (b)
  const r3 = nightRec({ 'The New York Times': 10, Vulture: 260 }, files, { census: false });
  r3.reference = { '2h': r2.reference['2h'] };
  assert.equal(sn(r3).status, 'fail');
});

test('BRO-6079 review fixes: text publishDate never counts as the night; deferral stops at the same-night window and is recorded', () => {
  const census = { entries: [{ outletId: 'variety' }], count: 1, sourcesPresent: ['dtli'], hadAnySource: true };
  const old = { outletId: 'variety', firstSeenAt: '2026-06-10T12:00:00.000Z', publishDate: 'October 12, 2019', includable: false, reason: 'wrongProduction', syndicatedUnder: null };
  assert.deepEqual(stateLib.censusExclusions(census, [old], { windowStartMs: winStartMs, night: '2026-10-22' }), []);
  const c2 = { entries: [{ outletId: 'vulture' }, { outletId: 'nytimes' }], count: 2, sourcesPresent: ['dtli'], hadAnySource: true };
  const r = nightRec({ 'The New York Times': 10 }, [file('nytimes', 5), file('vulture', 180)], { census: false });
  assert.deepEqual(lib.coverageAt(r, c2, Date.parse(at(120)), { deferLateSeen: true }).deferredToLateRule, ['vulture']);
  const r2 = nightRec({ 'The New York Times': 10 }, [file('nytimes', 5), file('vulture', 400)], { census: false });
  const ref = lib.coverageAt(r2, c2, Date.parse(at(120)), { deferLateSeen: true });
  assert.deepEqual(ref.missing, ['vulture']); // first seen past +3h: graded by neither rule, so stays missing
});

// BRO-6614: per-show embargo override, start guard, dual grading when the release came late.
const { MARKET_TZ, utcFromZoned } = require('./opening-night-windows.js');
const marketHour = (s) => (MARKET_TZ[s.category] && lib.EMBARGO_HOUR_LOCAL[s.category] != null && s.openingDate
  ? utcFromZoned(s.openingDate, lib.EMBARGO_HOUR_LOCAL[s.category], 0, MARKET_TZ[s.category]).toISOString() : null);

test('reviewEmbargoAt: a valid override wins and is normalized to ISO UTC', () => {
  const show = { id: 'afgm', category: 'broadway', openingDate: '2026-10-29' };
  assert.equal(lib.defaultEmbargoAt(show), '2026-10-30T02:00:00.000Z');
  assert.equal(lib.defaultEmbargoAt({ ...show, reviewEmbargoAt: '2026-10-30T03:00:00Z' }), '2026-10-30T03:00:00.000Z');
  assert.equal(lib.defaultEmbargoAt({ ...show, reviewEmbargoAt: '2026-10-29T23:00:00-04:00' }), '2026-10-30T03:00:00.000Z');
  assert.deepEqual(lib.embargoInfo({ ...show, reviewEmbargoAt: '2026-10-30T03:00:00Z' }), { at: '2026-10-30T03:00:00.000Z', source: 'override', problem: null });
  // West End matinee-ish press release at 17:00 UK is still the opening night
  assert.equal(lib.defaultEmbargoAt({ id: 'w', category: 'west-end', openingDate: '2026-11-03', reviewEmbargoAt: '2026-11-03T17:00:00Z' }), '2026-11-03T17:00:00.000Z');
});

test('reviewEmbargoAt absent: identical to the market-hour formula for every show (and across DST edges)', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'shows.json');
  let shows = [];
  if (fs.existsSync(file)) { const d = JSON.parse(fs.readFileSync(file, 'utf8')); shows = (d.shows || d).filter((s) => s && s.reviewEmbargoAt == null); }
  const fixed = ['2026-03-07', '2026-03-08', '2026-03-29', '2026-10-25', '2026-10-31', '2026-11-01', '2026-12-31']
    .flatMap((d) => ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'tour', undefined].map((category) => ({ id: `${category}-${d}`, category, openingDate: d })));
  for (const s of [...fixed, ...shows, { id: 'no-date', category: 'broadway' }]) {
    assert.equal(lib.defaultEmbargoAt(s), marketHour(s), s.id);
  }
});

test('reviewEmbargoAt: a typo cannot move the night (wrong day, no offset, junk) and is ignored with a reason', () => {
  const show = { id: 'afgm', category: 'broadway', openingDate: '2026-10-29' };
  for (const bad of ['2026-10-31T03:00:00Z', '2026-10-29T03:00:00Z', '2026-10-30T03:00:00', '23:00', 1730257200000, '2026-13-30T03:00:00Z', '2026-10-29T25:00:00Z']) {
    const s = { ...show, reviewEmbargoAt: bad };
    assert.ok(lib.embargoOverrideProblem(s), `accepted ${bad}`);
    assert.equal(lib.defaultEmbargoAt(s), '2026-10-30T02:00:00.000Z', `${bad} moved the embargo`);
  }
  assert.equal(lib.embargoOverrideProblem(show), null);
  assert.equal(lib.embargoOverrideProblem({ ...show, reviewEmbargoAt: '2026-10-30T07:59:00Z' }), null); // 03:59 ET next day
  assert.ok(lib.embargoOverrideProblem({ ...show, reviewEmbargoAt: '2026-10-30T08:00:00Z' })); // 04:00 ET is the next day
  assert.ok(lib.embargoOverrideProblem({ id: 't', category: 'tour', openingDate: '2026-10-29', reviewEmbargoAt: '2026-10-30T02:00:00Z' }));
  // Date.parse rolls an impossible date into the night (Feb 29 2026 -> Mar 1); it must still be rejected.
  const mar = { id: 'm', category: 'broadway', openingDate: '2026-03-01' };
  assert.match(lib.embargoOverrideProblem({ ...mar, reviewEmbargoAt: '2026-02-29T23:00:00-05:00' }) || '', /does not parse/);
  assert.match(lib.embargoOverrideProblem({ ...mar, reviewEmbargoAt: '2026-02-30T03:00:00Z' }) || '', /does not parse/);
  assert.equal(lib.embargoOverrideProblem({ ...mar, reviewEmbargoAt: '2026-03-01T23:00:00-05:00' }), null);
});

test('reviewEmbargoAt: valid but outside the orchestrator crons\' reach warns (dispatch by hand)', () => {
  const show = { id: 'afgm', category: 'broadway', openingDate: '2026-10-29' };
  assert.equal(lib.embargoOverrideReachWarning({ ...show, reviewEmbargoAt: '2026-10-30T03:00:00Z' }), null);
  assert.equal(lib.embargoOverrideReachWarning({ ...show, reviewEmbargoAt: '2026-10-29T23:00:00Z' }), null); // 19:00 ET, -180 min
  assert.match(lib.embargoOverrideReachWarning({ ...show, reviewEmbargoAt: '2026-10-29T20:00:00Z' }), /by hand/); // 16:00 ET
  assert.match(lib.embargoOverrideReachWarning({ ...show, reviewEmbargoAt: '2026-10-30T05:30:00Z' }), /by hand/); // 01:30 ET
  assert.equal(lib.embargoOverrideReachWarning({ ...show, reviewEmbargoAt: 'junk' }), null); // the problem, not the reach, reports it
});

test('start guard: probeDue opens its window from the override, and a start past the lead is still due (at once)', () => {
  const show = { id: 'x', category: 'broadway', openingDate: '2026-10-29', reviewEmbargoAt: '2026-10-30T03:00:00Z' };
  const emb = Date.parse('2026-10-30T03:00:00Z');
  assert.equal(lib.probeDue(show, emb - 151 * 60000), null);
  assert.equal(lib.probeDue(show, emb - 150 * 60000).embargoAt, '2026-10-30T03:00:00.000Z');
  // 00:45Z: inside the override's window, and before the market default's -2.5h would have opened? no: default opens 23:30Z
  assert.ok(lib.probeDue(show, Date.parse('2026-10-30T00:45:00Z')));
  // 05:30Z: the default's window (to 05:00Z) is closed, the override's (to 06:00Z) is open
  assert.equal(lib.probeDue({ ...show, reviewEmbargoAt: undefined }, Date.parse('2026-10-30T05:30:00Z')), null);
  assert.ok(lib.probeDue(show, Date.parse('2026-10-30T05:30:00Z')));
  // an earlier override (19:00 ET): the 01:00Z cron is past embargo - PROBE_LEAD_MIN, still due so the probe starts at once
  const early = { ...show, reviewEmbargoAt: '2026-10-29T23:00:00Z' };
  const due = lib.probeDue(early, Date.parse('2026-10-30T01:00:00Z'));
  assert.equal(due.embargoAt, '2026-10-29T23:00:00.000Z');
  assert.ok(Date.parse('2026-10-30T01:00:00Z') > Date.parse(due.embargoAt) - lib.PROBE_LEAD_MIN * 60000);
});

test('classifyEmbargo: override, market default or manual, by comparison with the passed time', () => {
  const show = { id: 'x', category: 'broadway', openingDate: '2026-10-29' };
  assert.equal(lib.classifyEmbargo(show, '2026-10-30T02:00:00Z'), 'market-default');
  assert.equal(lib.classifyEmbargo(show, '2026-10-30T03:00:00Z'), 'manual');
  const o = { ...show, reviewEmbargoAt: '2026-10-30T03:00:00Z' };
  assert.equal(lib.classifyEmbargo(o, '2026-10-30T03:00:00.000Z'), 'override');
  // the override added after dispatch: the record's default time is still recognized as assumed
  assert.equal(lib.classifyEmbargo(o, '2026-10-30T02:00:00Z'), 'market-default');
  const fr = lib.emptyRecord({ showId: 'x', night: '2026-10-29', embargoAt: '2026-10-30T02:00:00Z', embargoSource: 'market-default' });
  assert.equal(fr.embargoSource, 'market-default');
  assert.equal('embargoSource' in lib.emptyRecord({ showId: 'x', night: '2026-10-29', embargoAt: 'x' }), false);
});

const afgm = () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'audit', 'press-night', 'a-few-good-men-2026-2026-10-29.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

test('re-grading A Few Good Men 2026-10-29 reports the assumed 02:00Z and the observed 03:02Z verdicts', () => {
  const r = lib.evaluateCheck(afgm());
  const g = Object.fromEntries(r.gates.map((x) => [x.name, x]));
  assert.equal(r.verdict, 'FAIL'); // unchanged: the verdict uses the assumed embargo
  assert.match(g['coverage-2h'].detail, /^1\/14 /);
  assert.ok(r.release, 'no observed-release grade');
  assert.equal(r.release.assumedAt, '2026-10-30T02:00:00.000Z');
  assert.equal(r.release.observedAt, '2026-10-30T03:02:18.463Z');
  assert.equal(r.release.lateMin, 62);
  assert.equal(r.release.verdictUses, 'assumed');
  const o = Object.fromEntries(r.release.observed.gates.map((x) => [x.name, x]));
  assert.match(o['first-live'].detail, /33-38 min after/);
  assert.equal(o['first-live'].status, 'fail');
  assert.equal(o['coverage-2h'].status, 'pass');
  assert.match(o['coverage-2h'].detail, /^13\/14 .*re-derived from the \+2h census as of 2026-10-30T04:00.*missing: thewrap$/);
  assert.equal(o['same-night-completeness'].status, 'fail');
  assert.match(o['same-night-completeness'].detail, /thewrap/);
  assert.doesNotMatch(o['same-night-completeness'].detail, /nytimes/);
  assert.equal(r.release.observed.verdict, 'FAIL');
});

test('observed-release grade: none for an override or manual embargo, an on-time night, or a shadow started late', () => {
  assert.equal(lib.evaluateCheck({ ...afgm(), embargoSource: 'override' }).release, undefined);
  assert.equal(lib.evaluateCheck({ ...afgm(), embargoSource: 'manual' }).release, undefined);
  const rec = afgm();
  assert.equal(lib.evaluateCheck({ ...rec, laneShadow: { ...rec.laneShadow, firstDiscoveredAt: '2026-10-30T02:29:00Z' } }).release, undefined);
  assert.equal(lib.evaluateCheck({ ...rec, laneShadow: { ...rec.laneShadow, startedAt: '2026-10-30T02:10:00Z' } }).release, undefined);
  assert.ok(lib.evaluateCheck({ ...rec, embargoSource: 'market-default' }).release);
});

test('observed-release grade prefers the capture\'s 2h-observed reference, and is unknown on an open drop', () => {
  const rec = afgm();
  const stored = { status: 'complete', source: ['dtli'], count: 14, covered: 14, coverage: 1, missing: [], asOf: '2026-10-30T05:02:18.463Z', method: 'timeline', fetchedAt: '2026-10-30T08:00:23.651Z' };
  rec.reference['2h-observed'] = stored;
  const o = Object.fromEntries(lib.evaluateCheck(rec).release.observed.gates.map((x) => [x.name, x]));
  assert.match(o['coverage-2h'].detail, /^14\/14 /);
  const dropped = afgm();
  dropped.dropped = [{ key: 'x', outlet: 'Vulture', droppedAt: '2026-10-30T04:50:00Z', restoredAt: null }];
  assert.equal(lib.observedCoverage2h(dropped, Date.parse('2026-10-30T03:02:18.463Z')), null);
});

test('observed release: a review seen live before the lane\'s first discovery bounds the release (a late lane is not a late release)', () => {
  const rec = afgm();
  const firstLive = lib.firstNightLive(rec).at; // the probe saw Time Out live at 03:40Z
  const lateLane = { ...rec, laneShadow: { ...rec.laneShadow, firstDiscoveredAt: '2026-10-30T04:30:00Z' } };
  const r = lib.evaluateCheck(lateLane);
  assert.equal(r.release.observedAt, firstLive);
  assert.equal(r.release.observedFrom, 'first-live');
  assert.equal(lib.releaseSourceLabel(r.release), 'the first night review seen live');
  assert.equal(lib.evaluateCheck(rec).release.observedFrom, 'lane-discovery');
  assert.ok(Date.parse(r.release.observedAt) < Date.parse('2026-10-30T04:30:00Z'));
  // The probe and the lane both saw nothing until well after the embargo, so the late release still stands.
  assert.equal(lib.evaluateCheck(rec).release.observedAt, '2026-10-30T03:02:18.463Z');
});

test('observed release with no assumed +2h census keeps the no-census reason in the observed grade', () => {
  const rec = afgm();
  rec.reference['2h'] = { status: 'no-census-yet', coverage: null };
  const o = Object.fromEntries(lib.evaluateCheck(rec).release.observed.gates.map((x) => [x.name, x]));
  assert.equal(o['coverage-2h'].status, 'unknown');
  assert.match(o['coverage-2h'].detail, /no-census-yet/);
});
