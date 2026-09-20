/**
 * ci-green-rate-core.test.mjs — pins the measurement behind
 * scripts/ci-green-rate.js. Requires the REAL module (CLAUDE.md rule 15);
 * no logic is restated here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./ci-green-rate-core.js');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const H = 60 * 60 * 1000;

// Build a run `hoursAgo` hours before NOW with the given conclusion.
function run(hoursAgo, conclusion, extra = {}) {
  return { databaseId: Math.round(1e6 - hoursAgo * 100), conclusion, status: 'completed', createdAt: new Date(NOW - hoursAgo * H).toISOString(), ...extra };
}

test('rate and streaks on a mixed fixture (cancelled runs are transparent to streaks)', () => {
  // Chronological: G G R R R G R G G, with cancelled runs sprinkled in.
  const rows = [
    run(40, 'success'), run(38, 'success'),
    run(36, 'cancelled'),
    run(34, 'failure'), run(32, 'failure'), run(30, 'timed_out'),
    run(28, 'success'),
    run(26, 'cancelled'),
    run(24, 'failure'),
    run(22, 'success'), run(20, 'success'),
  ];
  const res = core.computeGreenRate(rows, { days: 7, min: 80, now: NOW });
  assert.deepEqual(res.counts, { total: 11, green: 5, red: 4, cancelled: 2, other: 0 });
  assert.equal(res.rate, 55.6);
  assert.equal(res.longestGreenStreak, 2);
  assert.equal(res.longestRedStreak, 3);
  assert.deepEqual(res.currentStreak, { color: 'green', length: 2 });
  assert.equal(res.redEpisodes, 2);
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, null);
  assert.equal(core.verdictLine(res), 'CI-GREEN-RATE: 55.6% over 7d (green 5 / red 4), min 80% → FAIL');
});

test('cancelled and other conclusions are excluded from the rate', () => {
  const rows = [run(10, 'cancelled'), run(9, 'success'), run(8, 'cancelled'), run(7, 'cancelled'), run(6, 'skipped')];
  const res = core.computeGreenRate(rows, { days: 7, min: 80, now: NOW });
  assert.equal(res.counts.cancelled, 3);
  assert.equal(res.counts.other, 1);
  assert.equal(res.rate, 100);
  assert.equal(res.verdict, 'PASS');
  assert.deepEqual(res.currentStreak, { color: 'green', length: 1 });
});

test('red→green latency: null with no transition, median over closed episodes otherwise', () => {
  const allGreen = core.computeGreenRate([run(5, 'success'), run(4, 'success')], { now: NOW });
  assert.equal(allGreen.redToGreenMedianMin, null);
  assert.equal(allGreen.redToGreenSamples, 0);

  const stillRed = core.computeGreenRate([run(5, 'success'), run(4, 'failure'), run(3, 'failure')], { now: NOW });
  assert.equal(stillRed.redToGreenMedianMin, null, 'an open red episode has no latency yet');
  assert.equal(stillRed.openRedEpisodeMin, 240);

  // Episode 1: first red at -10h, green at -9h → 60 min. Episode 2: first red at -5h, green at -3h → 120 min.
  const drained = core.computeGreenRate([
    run(10, 'failure'), run(9.5, 'failure'), run(9, 'success'),
    run(5, 'failure'), run(3, 'success'),
  ], { now: NOW });
  assert.equal(drained.redToGreenSamples, 2);
  assert.equal(drained.redToGreenMedianMin, 90);
  assert.equal(drained.openRedEpisodeMin, null);
});

test('PASS/FAIL threshold boundary is exact (no float rounding decides it)', () => {
  const fourOne = [run(5, 'success'), run(4, 'success'), run(3, 'success'), run(2, 'success'), run(1, 'failure')];
  assert.equal(core.computeGreenRate(fourOne, { min: 80, now: NOW }).verdict, 'PASS');
  assert.equal(core.computeGreenRate(fourOne, { min: 81, now: NOW }).verdict, 'FAIL');
  const threeOne = fourOne.slice(1);
  assert.equal(core.computeGreenRate(threeOne, { min: 80, now: NOW }).verdict, 'FAIL');
  assert.equal(core.computeGreenRate(threeOne, { min: 75, now: NOW }).verdict, 'PASS');
});

test('empty input is FAIL with a stated reason — never PASS on no data', () => {
  for (const rows of [[], null, undefined, [run(200, 'success')]]) {
    const res = core.computeGreenRate(rows, { days: 7, min: 0, now: NOW });
    assert.equal(res.verdict, 'FAIL', `rows=${JSON.stringify(rows)}`);
    assert.equal(res.rate, null);
    assert.match(res.reason, /no completed green\/red push runs in the last 7d/);
    assert.equal(core.verdictLine(res), `CI-GREEN-RATE: n/a over 7d (green 0 / red 0), min 0% → FAIL (${res.reason})`);
  }
});

test('window filter drops runs older than --days; per-day table is chronological', () => {
  const rows = [run(24 * 8, 'failure'), run(24 * 6, 'success'), run(2, 'success')];
  const res = core.computeGreenRate(rows, { days: 7, now: NOW });
  assert.equal(res.counts.total, 2);
  assert.equal(res.counts.red, 0);
  assert.deepEqual(res.perDay.map((d) => d.date), ['2026-09-14', '2026-09-20']);
  assert.equal(res.perDay[0].green, 1);
});

test('normalizeRuns accepts raw REST rows, drops in-progress and unparseable rows, sorts oldest-first', () => {
  const rows = [
    { id: 3, conclusion: 'success', status: 'completed', created_at: '2026-09-20T10:00:00Z' },
    { id: 2, conclusion: null, status: 'in_progress', created_at: '2026-09-20T11:00:00Z' },
    { id: 1, conclusion: 'failure', status: 'completed', created_at: '2026-09-20T09:00:00Z' },
    { id: 9, conclusion: 'failure', status: 'completed', created_at: 'garbage' },
  ];
  const n = core.normalizeRuns(rows);
  assert.deepEqual(n.map((r) => [r.id, r.color]), [[1, 'red'], [3, 'green']]);
});

test('buildRunsApiPath: completed push runs on main, per_page capped, created filter percent-encoded', () => {
  const p = core.buildRunsApiPath({ page: 2, sinceDate: '2026-09-12' });
  assert.equal(p, 'repos/{owner}/{repo}/actions/workflows/test.yml/runs?per_page=100&page=2&branch=main&event=push&status=completed&created=%3E%3D2026-09-12');
  assert.throws(() => core.buildRunsApiPath({ perPage: 101 }), /per_page cap/);
  assert.equal(core.windowStartDate(7, NOW), '2026-09-12');
});

test('parseCliArgs: the acceptance-command shape, --k=v form, and rejects bad values', () => {
  const a = core.parseCliArgs(['--days', '7', '--min', '80']);
  assert.equal(a.days, 7); assert.equal(a.min, 80); assert.equal(a.json, false);
  const b = core.parseCliArgs(['--days=1', '--json']);
  assert.equal(b.days, 1); assert.equal(b.json, true);
  const d = core.parseCliArgs([]);
  assert.equal(d.days, 7); assert.equal(d.min, 80); assert.equal(d.error, undefined);
  assert.match(core.parseCliArgs(['--days', 'x']).error, /--days must be an integer/);
  assert.match(core.parseCliArgs(['--min', '101']).error, /--min must be an integer 0-100/);
  assert.match(core.parseCliArgs(['--bogus']).error, /unknown argument/);
  assert.match(core.parseCliArgs(['--days']).error, /needs a value/);
});

test('formatReport ends with the verdict line and never says "fixed"', () => {
  const res = core.computeGreenRate([run(5, 'success'), run(4, 'failure'), run(3, 'success')], { now: NOW });
  const text = core.formatReport(res);
  const lines = text.split('\n');
  assert.equal(lines[lines.length - 1], core.verdictLine(res));
  assert.doesNotMatch(text, /fixed/i);
  assert.match(text, /red→green latency median: 60 min \(1 sample\)/);
});
