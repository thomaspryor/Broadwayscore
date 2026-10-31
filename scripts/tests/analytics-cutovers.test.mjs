import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cutoverWeeks, cutoversAffecting } = require('../lib/analytics-cutovers.js');
const { detectSpikes, newSources } = require('../analyze-traffic-sources.js');

const cut = [{ date: '2026-10-22', label: 'x', suppressWeeksAfter: 1 }];
const weeks = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];

test('cutoverWeeks covers the cutover week and the next', () => {
  assert.deepEqual([...cutoverWeeks(cut)], ['2026-10-19', '2026-10-26']);
});

test('cutoversAffecting matches only windows that include a suppressed week', () => {
  assert.equal(cutoversAffecting(['2026-10-05'], cut).length, 0);
  assert.equal(cutoversAffecting(['2026-10-26'], cut).length, 1);
});

test('detectSpikes skips suppressed weeks but flags later ones', () => {
  const series = { 'blog.example': { '2026-10-05': 40, '2026-10-12': 40, '2026-10-19': 200, '2026-10-26': 200, '2026-11-02': 400 } };
  const flagged = detectSpikes(series, weeks, { currentWeek: null, suppressWeeks: cutoverWeeks(cut) }).map((s) => s.week);
  assert.ok(!flagged.includes('2026-10-19') && !flagged.includes('2026-10-26'));
  assert.ok(flagged.includes('2026-11-02'));
  assert.ok(detectSpikes(series, weeks, { suppressWeeks: new Set() }).some((s) => s.week === '2026-10-19'));
});

test('newSources ignores sources first seen in a cutover week', () => {
  const w = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  const series = { 'newsite.example': { '2026-10-19': 9 }, 'older.example': { '2026-10-05': 9 } };
  const keys = newSources(series, w, null, { minTotal: 5, suppressWeeks: cutoverWeeks(cut) }).map((x) => x.key);
  assert.deepEqual(keys, ['older.example']);
});

test('human summary: search quality lines and cutover note', () => {
  const { buildHumanSummary } = require('../lib/traffic-report-human.js');
  const wk = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  const rows = (key, n) => wk.slice(0, -1).map((d) => ({ date: d, key, sessions: n, users: n }));
  const ph = {
    channelType: [...rows('Organic Search', 100), ...rows('Direct', 20)],
    searchEngine: [...rows('Google', 70), ...rows('Bing', 10)],
    searchLanding: [...rows('/show/a', 30), ...rows('/show/b', 30)],
    searchShowDepth: [...rows('multi', 10), ...rows('single', 40)],
    errors: {},
  };
  // A fixture, not the live CUTOVERS list, so a date fix there cannot break this test.
  const out = buildHumanSummary({ ph, ga: { skipped: 'x' }, weeks: wk, currentWeek: '2026-10-26', cutovers: cut });
  assert.match(out, /Google sent 70 visits \(usually 70\) and Bing sent 10/);
  assert.match(out, /Search landed people on 2 different pages/);
  assert.match(out, /20% went on to look at a second page/);
  assert.match(out, /Heads up: on Oct 22/);
  // a failed query drops its line instead of printing zeros
  const out2 = buildHumanSummary({ ph: { ...ph, searchEngine: [], errors: { searchEngine: 'boom' } }, ga: { skipped: 'x' }, weeks: wk, currentWeek: '2026-10-26' });
  assert.doesNotMatch(out2, /Google sent/);
});
