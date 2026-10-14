// Recoupment-timing ground truth (BRO-5073). require()s the real helpers (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const T = require('../../scripts/lib/recoupment-timing');
const { buildTimingRows, recoupBias, crossingPass } = require('../../scripts/lib/recoupment-timing-report');
const { calculateRecoupment } = require('../../scripts/lib/recoupment-model');

describe('announcementDate', () => {
  test('a month is tightened to the day the cited source names in that month', () => {
    assert.deepEqual(T.announcementDate({ recoupedDate: '2011-11', recoupedSource: 'Hollywood Reporter (Nov 29, 2011): "has recouped"' }), { date: '2011-11-29', precision: 'day' });
    assert.deepEqual(T.announcementDate({ recoupedDate: '2017-07', recoupedSource: 'Forbes article from July 17, 2017 reporting recoupment' }), { date: '2017-07-17', precision: 'day' });
  });
  test('a source date in another month does not move it', () => {
    assert.deepEqual(T.announcementDate({ recoupedDate: '2022-12', recoupedSource: 'BroadwayWorld (Mar 23, 2023): "The show recouped in December 2022"' }), { date: '2022-12-01', precision: 'month' });
  });
  test('a year alone is too coarse', () => {
    assert.equal(T.announcementDate({ recoupedDate: '2014' }), null);
    assert.equal(T.announcementDate({}), null);
  });
});

describe('recoupWindow', () => {
  test('two weeks before a day; the whole month for a month', () => {
    assert.deepEqual(T.recoupWindow({ date: '2017-07-17', precision: 'day' }), ['2017-07-03', '2017-07-17']);
    assert.deepEqual(T.recoupWindow({ date: '2024-02-01', precision: 'month' }), ['2024-02-01', '2024-02-29']);
  });
});

describe('timingTruth', () => {
  const show = { previewsStartDate: '2016-11-14', openingDate: '2016-12-04' };
  const comm = { recouped: true, recoupedDate: '2017-07', recoupedSource: 'Forbes (July 17, 2017): recouped its $9.5 million' };
  test('at-recoup band plus the earlier checkpoints the run reaches', () => {
    const t = T.timingTruth(comm, show);
    assert.equal(t.truthClass, 'reported');
    assert.deepEqual(t.checkpoints.map((c) => c.label), ['at-recoup', '26w-before']);
    assert.deepEqual([t.checkpoints[0].lo, t.checkpoints[0].hi], T.RECOUP_BAND);
    assert.equal(t.checkpoints[1].hi, 99.99);
    assert.equal(t.checkpoints[1].from, '2017-01-02');
  });
  test('announcement lag: open-topped band at the announcement, <= 115 at the lag start, earlier checkpoints shift back', () => {
    const t = T.timingTruth(comm, show, { lagWeeks: 13 });
    assert.deepEqual(t.checkpoints.map((c) => c.label), ['at-recoup', 'lag-start']);
    assert.deepEqual([t.checkpoints[0].lo, t.checkpoints[0].hi], [85, Infinity]);
    assert.deepEqual([t.checkpoints[1].from, t.checkpoints[1].hi], ['2017-04-03', 115]);
    // 26 weeks before a lag start that falls before the first preview: dropped.
    assert.ok(!T.timingTruth(comm, show, { lagWeeks: 13 }).checkpoints.some((c) => c.label === '26w-before'));
    // A lag start before the first preview: only the announcement decides.
    assert.deepEqual(T.timingTruth(comm, show, { lagWeeks: 52 }).checkpoints.map((c) => c.label), ['at-recoup']);
  });
  test('not recouped or no source: no timing truth', () => {
    assert.equal(T.timingTruth({ ...comm, recouped: false }, show), null);
    assert.equal(T.timingTruth({ ...comm, recoupedSource: '' }, show), null);
  });
  test('a recoupment announced after closing is not a running-show test', () => {
    assert.deepEqual(T.timingTruth(comm, { ...show, closingDate: '2017-05-01' }).checkpoints.map((c) => c.label), ['26w-before']);
    assert.equal(T.timingTruth(comm, { ...show, closingDate: '2016-12-20' }), null);
    assert.ok(T.timingTruth(comm, { ...show, closingDate: '2017-07-10' }));
  });
  test('an admission that nobody announced it stays inference', () => {
    assert.equal(T.timingTruth({ ...comm, recoupedSource: 'Disney does not announce recoupments. Deadline (May 2, 2017).' }, show).truthClass, 'inference');
  });
});

describe('windowError', () => {
  const band = { lo: 85, hi: 115 };
  test('inside when the model interval touches the band', () => {
    assert.equal(T.windowError(70, 90, band), 0);
    assert.equal(T.windowError(110, 140, band), 0);
  });
  test('distance to the nearest edge otherwise', () => {
    assert.equal(T.windowError(60, 75, band), 10);
    assert.equal(T.windowError(130, 146.5, band), 15);
    assert.equal(T.windowError(120, 120, { lo: -Infinity, hi: 99.99 }), 120 - 99.99);
  });
});

test('hideRecoupment strips every recoupment field and leaves the rest', () => {
  const out = T.hideRecoupment({ recouped: true, recoupedDate: '2017-07', recoupedSource: 'x', recoupedTruthClass: 'reported', modelRecouped: true, capitalization: 1 });
  assert.deepEqual(out, { capitalization: 1 });
});

test('historyCoverage counts rows from an earlier production sharing the key', () => {
  const weekly = { '2001-05-06': {}, '2024-03-03': {}, '2024-03-10': {}, '2024-09-01': {} };
  assert.deepEqual(T.historyCoverage(weekly, { previewsStartDate: '2024-03-01' }, '2024-06-30'), { own: 2, before: 1 });
});

describe('modelAt', () => {
  const libs = { classifyTier: require('../../scripts/lib/model-return-v2').classifyTier, calculateRecoupment };
  const weekly = {};
  for (let i = 0; i < 40; i++) weekly[new Date(Date.UTC(2017, 0, 1 + 7 * i)).toISOString().slice(0, 10)] = { gross: 1500000 };
  const lookup = { getGrossesAllTime: () => ({ gross: 1e9, performances: 8000 }), getWeeklyData: () => weekly };
  const show = { slug: 'x', type: 'musical', previewsStartDate: '2016-12-20', openingDate: '2017-01-10', closingDate: '2030-01-01' };
  test('a show that ran ten years still replays on the weekly model as of an early date', () => {
    const r = T.modelAt(libs, show, { capitalization: 10e6, weeklyRunningCost: 600000 }, lookup, '2017-06-30');
    assert.equal(r.tier, 'weekly-model');
    assert.ok(r.result.totalRunWeeks < 40);
  });
  test('a 2021 SVOG grant is not netted off the cap before it was paid', () => {
    // dear-evan-hansen-2016 carries a KNOWN_SVOG entry
    const r = T.modelAt(libs, { ...show, slug: 'dear-evan-hansen-2016' }, { capitalization: 10e6, weeklyRunningCost: 600000 }, lookup, '2017-06-30');
    assert.equal(r.result.svogGrant, 0);
  });
});

describe('displayableAt', () => {
  const guard = require('../../scripts/lib/model-display-guard');
  const result = { recoupmentPctLow: 60, recoupmentPctCentral: 80, recoupmentPctHigh: 100, dataQuality: 'medium' };
  test('shown when the guard would show it with the launch flag on', () => {
    assert.equal(T.displayableAt({ comm: { capitalization: 1 }, tier: 'weekly-model', result, playedWeeks: 20 }, guard), true);
  });
  test('hidden for few weeks, a nonprofit, low quality or a wide range', () => {
    assert.equal(T.displayableAt({ comm: {}, tier: 'weekly-model', result, playedWeeks: 8 }, guard), false);
    assert.equal(T.displayableAt({ comm: { designation: 'Nonprofit' }, tier: 'weekly-model', result, playedWeeks: 20 }, guard), false);
    assert.equal(T.displayableAt({ comm: {}, tier: 'weekly-model', result: { ...result, dataQuality: 'low' }, playedWeeks: 20 }, guard), false);
    assert.equal(T.displayableAt({ comm: {}, tier: 'weekly-model', result: { ...result, recoupmentPctHigh: 150 }, playedWeeks: 20 }, guard), false);
  });
  test('a replay with a reported cost is not marked low only for lacking cumulative grosses', () => {
    assert.equal(T.displayableAt({ comm: {}, tier: 'weekly-model', result: { ...result, dataQuality: 'low', weeklyFixedCostSource: 'reported' }, playedWeeks: 20 }, guard), true);
    assert.equal(T.displayableAt({ comm: {}, tier: 'weekly-model', result: { ...result, dataQuality: 'low', weeklyFixedCostSource: 'estimated' }, playedWeeks: 20 }, guard), false);
  });
});

test('buildTimingRows replays a recouped record with the recoupment hidden', () => {
  const weekly = {};
  for (let i = 0; i < 60; i++) weekly[new Date(Date.UTC(2016, 10, 20 + 7 * i)).toISOString().slice(0, 10)] = { gross: 1400000 };
  const lookup = { getGrossesAllTime: () => ({ gross: 1e9, performances: 8000 }), getWeeklyData: () => weekly };
  const show = { id: 's', slug: 's', type: 'musical', previewsStartDate: '2016-11-14', openingDate: '2016-12-04', closingDate: '2022-09-18' };
  const libs = { classifyTier: require('../../scripts/lib/model-return-v2').classifyTier, calculateRecoupment };
  const seen = [];
  const spy = { classifyTier: libs.classifyTier, calculateRecoupment: (s, c, ...rest) => { seen.push(c); return calculateRecoupment(s, c, ...rest); } };
  const commercial = { s: { recouped: true, recoupedDate: '2017-07', recoupedSource: 'Forbes (July 17, 2017): recouped', capitalization: 9.5e6, weeklyRunningCost: 600000 } };
  const { rows } = buildTimingRows({ shows: [show], commercial, lookup, by: { s: show }, oldLibs: libs, newLibs: spy });
  assert.deepEqual(rows.map((r) => r.kind), ['timing:at-recoup', 'timing:26w-before']);
  assert.ok(seen.length && seen.every((c) => !('recouped' in c) && !('recoupedDate' in c)));
  assert.equal(typeof recoupBias(rows), 'number');
});

test('revisitBar: 10+ strong rows at 80%+ inside, plays and musicals each (BRO-5073)', () => {
  const { revisitBar } = require('../../scripts/lib/recoupment-timing-report');
  const row = (type, inside, extra = {}) => ({ type, displayable: true, truthClass: 'reported', kind: 'timing:at-recoup', newErr: inside ? 0 : 5, ...extra });
  const many = (type, n, inside) => Array.from({ length: n }, (_, i) => row(type, i < inside));
  assert.deepEqual(revisitBar([...many('play', 10, 8), ...many('musical', 10, 8)]), { met: true, play: { n: 10, inside: 8 }, musical: { n: 10, inside: 8 } });
  assert.equal(revisitBar([...many('play', 10, 7), ...many('musical', 12, 12)]).met, false, 'plays under 80%');
  assert.equal(revisitBar([...many('play', 9, 9), ...many('musical', 12, 12)]).met, false, 'too few plays');
  // weak, non-displayable and inference rows do not count
  const noise = [row('play', true, { kind: 'timing:26w-before' }), row('play', true, { displayable: false }), row('play', true, { truthClass: 'inference' })];
  assert.equal(revisitBar([...many('play', 9, 9), ...noise, ...many('musical', 10, 10)]).play.n, 9);
});

test('revisitBarStatus: warn when the bar is met, pass while it is not (BRO-5073)', () => {
  const { revisitBarStatus } = require('../../scripts/lib/recoupment-timing-report');
  const g = (n, inside) => ({ n, inside });
  assert.equal(revisitBarStatus({ revisitBar: { met: false, play: g(3, 1), musical: g(2, 2) } }).status, 'pass');
  assert.match(revisitBarStatus({ revisitBar: { met: false, play: g(3, 1), musical: g(2, 2) } }).message, /plays 1\/3 inside, musicals 2\/2/);
  assert.equal(revisitBarStatus({ revisitBar: { met: true, play: g(10, 9), musical: g(11, 10) } }).status, 'warn');
  assert.equal(revisitBarStatus(null).status, 'warn');
});

describe('crossingPass', () => {
  test('a show passes only when every crossing checkpoint is inside', () => {
    const rows = [
      { slug: 'a', type: 'play', kind: 'timing:at-recoup', newErr: 0, displayable: true },
      { slug: 'a', type: 'play', kind: 'timing:lag-start', newErr: 0 },
      { slug: 'b', type: 'musical', kind: 'timing:at-recoup', newErr: 0 },
      { slug: 'b', type: 'musical', kind: 'timing:lag-start', newErr: 30 },
      { slug: 'b', type: 'musical', kind: 'timing:26w-before', newErr: 0 },
    ];
    const out = Object.fromEntries(crossingPass(rows).map((e) => [e.slug, e]));
    assert.deepEqual([out.a.ok, out.a.strong, out.a.play], [true, true, true]);
    assert.deepEqual([out.b.ok, out.b.strong], [false, false]);
  });
});
