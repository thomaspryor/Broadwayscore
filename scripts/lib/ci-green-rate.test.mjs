/**
 * ci-green-rate.test.mjs — pins the measurement behind scripts/ci-green-rate.js
 * and health-check.js's "Main: green rate" row. Requires the REAL modules
 * (CLAUDE.md rule 15); no logic is restated here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./ci-green-rate.js');
const { explainUnsafeCheckCommand } = require('./autonomous-triage-core.js');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const H = 60 * 60 * 1000;
const D = 24 * H;

// Build a run `hoursAgo` hours before NOW with the given conclusion. Each run
// gets its own sha unless overridden, so rerun-collapse never fires by accident.
let seq = 0;
function run(hoursAgo, conclusion, extra = {}) {
  seq++;
  return { databaseId: Math.round(1e6 - hoursAgo * 100), headSha: `sha${seq}`, conclusion, status: 'completed', createdAt: new Date(NOW - hoursAgo * H).toISOString(), ...extra };
}
const greens = (n, startH = n + 1) => Array.from({ length: n }, (_, i) => run(startH - i, 'success'));

test('rate and streaks on a mixed fixture (cancelled runs are transparent to streaks)', () => {
  // Chronological: G G R R R G R G G G G, with cancelled runs sprinkled in.
  const rows = [
    run(40, 'success'), run(38, 'success'),
    run(36, 'cancelled'),
    run(34, 'failure'), run(32, 'failure'), run(30, 'timed_out'),
    run(28, 'success'),
    run(26, 'cancelled'),
    run(24, 'failure'),
    run(22, 'success'), run(20, 'success'), run(18, 'success'), run(16, 'success'),
  ];
  const res = core.computeGreenRate(rows, { days: 7, min: 80, now: NOW });
  assert.deepEqual(res.counts, { total: 13, green: 7, red: 4, cancelled: 2, other: 0 });
  assert.equal(res.rate, 63.6);
  assert.equal(res.longestGreenStreak, 4);
  assert.equal(res.longestRedStreak, 3);
  assert.deepEqual(res.currentStreak, { color: 'green', length: 4 });
  assert.equal(res.redEpisodes, 2);
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, null);
  assert.equal(core.verdictLine(res), 'CI-GREEN-RATE: rate 63.6% (green 7 / red 4, 13 runs, 2 cancelled), 7d trend from n/a, day 0 of 14 at ≥80% → FAIL');
});

test('cancelled and other conclusions are excluded from the rate but reported', () => {
  const rows = [...greens(10, 30), run(9, 'cancelled'), run(8, 'cancelled'), run(7, 'cancelled'), run(6, 'skipped')];
  const res = core.computeGreenRate(rows, { days: 7, min: 80, now: NOW });
  assert.equal(res.counts.cancelled, 3);
  assert.equal(res.counts.other, 1);
  assert.equal(res.rate, 100);
  assert.equal(res.verdict, 'PASS');
  assert.match(core.verdictLine(res), /\(green 10 \/ red 0, 14 runs, 3 cancelled\)/);
});

test('reruns collapse by head_sha — the latest attempt wins', () => {
  const base = greens(10, 40);
  // sha "X": red at -5h, re-run green at -4h → green. sha "Y": green at -3h, re-run red at -2h → red.
  const rows = [...base,
    run(5, 'failure', { headSha: 'X' }), run(4, 'success', { headSha: 'X' }),
    run(3, 'success', { headSha: 'Y' }), run(2, 'failure', { headSha: 'Y' }),
  ];
  const res = core.computeGreenRate(rows, { now: NOW });
  assert.equal(res.rerunsCollapsed, 2);
  assert.deepEqual(res.counts, { total: 12, green: 11, red: 1, cancelled: 0, other: 0 });
  assert.deepEqual(res.currentStreak, { color: 'red', length: 1 });
});

test('duplicate run ids from shifting pages are counted once', () => {
  const g = greens(10, 20);
  const res = core.computeGreenRate([...g, ...g.slice(0, 3)], { now: NOW });
  assert.equal(res.counts.total, 10);
});

test('red→green latency: null with no transition, median over closed episodes otherwise', () => {
  const allGreen = core.computeGreenRate(greens(12), { now: NOW });
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
  const eightTwo = [...greens(8, 20), run(2, 'failure'), run(1, 'failure')];
  assert.equal(core.computeGreenRate(eightTwo, { min: 80, now: NOW }).verdict, 'PASS');
  assert.equal(core.computeGreenRate(eightTwo, { min: 81, now: NOW }).verdict, 'FAIL');
  const nineThree = [...greens(9, 20), run(3, 'failure'), run(2, 'failure'), run(1, 'failure')];
  assert.equal(core.computeGreenRate(nineThree, { min: 76, now: NOW }).verdict, 'FAIL');
  assert.equal(core.computeGreenRate(nineThree, { min: 75, now: NOW }).verdict, 'PASS');
});

test('guards: no data, sample floor, cancel storm and truncated window are FAIL with a stated reason — never PASS', () => {
  for (const rows of [[], null, undefined, [run(200, 'success')]]) {
    const res = core.computeGreenRate(rows, { days: 7, min: 0, now: NOW });
    assert.equal(res.verdict, 'FAIL', `rows=${JSON.stringify(rows)}`);
    assert.equal(res.rate, null);
    assert.match(res.reason, /no completed green\/red push runs in the last 7d/);
    assert.equal(core.verdictLine(res), `CI-GREEN-RATE: rate n/a (green 0 / red 0, 0 runs), 7d trend from n/a, day 0 of 14 at ≥0% → FAIL (${res.reason})`);
  }
  const nine = core.computeGreenRate(greens(9), { min: 0, now: NOW });
  assert.equal(nine.verdict, 'FAIL');
  assert.match(nine.reason, /only 9 scored runs .* floor is 10/);
  assert.equal(core.computeGreenRate(greens(10), { min: 0, now: NOW }).verdict, 'PASS');

  const storm = core.computeGreenRate([...greens(10, 30), ...Array.from({ length: 11 }, (_, i) => run(i + 1, 'cancelled'))], { now: NOW });
  assert.equal(storm.verdict, 'FAIL');
  assert.match(storm.reason, /cancel storm: 11 cancelled vs 10 scored/);

  const trunc = core.computeGreenRate(greens(12), { now: NOW, truncated: true });
  assert.equal(trunc.verdict, 'FAIL');
  assert.match(core.verdictLine(trunc), /→ FAIL \(window incomplete: page cap hit/);
  assert.match(core.formatReport(trunc), /\[TRUNCATED: page cap hit\]/);
});

test('window filter drops runs older than --days; per-day table is chronological', () => {
  const rows = [run(24 * 8, 'failure'), run(24 * 6, 'success'), run(2, 'success')];
  const res = core.computeGreenRate(rows, { days: 7, now: NOW });
  assert.equal(res.counts.total, 2);
  assert.equal(res.counts.red, 0);
  assert.deepEqual(res.perDay.map((d) => d.date), ['2026-09-14', '2026-09-20']);
  assert.equal(res.perDay[0].green, 1);
});

test('assessTrend: 7d-ago reading, consecutive-PASS-day streak, today always = current reading', () => {
  const led = (daysAgo, rate, verdict, hour = 6) => ({ ts: new Date(NOW - daysAgo * D - (12 - hour) * H).toISOString(), rate, verdict });
  const ledger = [
    led(9, 40, 'FAIL'), led(8, 55, 'FAIL'), led(7, 61, 'FAIL'),
    led(3, 85, 'PASS'), led(2, 88, 'PASS'), led(1, 90, 'PASS'),
    led(0, 30, 'FAIL', 3), // an earlier reading today — must NOT outrank the current one
  ];
  const up = core.assessTrend(ledger, { now: NOW, current: { rate: 91, verdict: 'PASS' } });
  assert.equal(up.fromRate, 61, 'the latest reading at least 7 days old');
  assert.equal(up.fromDate, '2026-09-13');
  assert.equal(up.streakDays, 4, 'today + 3 consecutive PASS days; the gap at day 4 ends it');
  assert.equal(up.target, 14);

  const down = core.assessTrend(ledger, { now: NOW, current: { rate: 50, verdict: 'FAIL' } });
  assert.equal(down.streakDays, 0, 'a FAIL today is day 0 regardless of history');

  const fresh = core.assessTrend([], { now: NOW, current: { rate: 95, verdict: 'PASS' } });
  assert.deepEqual(fresh, { fromRate: null, fromDate: null, streakDays: 1, target: 14 });

  // Through computeGreenRate + verdictLine (the digest string).
  const res = core.computeGreenRate(greens(12), { now: NOW, ledgerRows: ledger });
  assert.match(core.verdictLine(res), /, 7d trend from 61%, day 4 of 14 at ≥80% → PASS$/);
  assert.deepEqual(core.ledgerRow(res), { ts: res.windowEnd, days: 7, min: 80, rate: 100, green: 12, red: 0, cancelled: 0, total: 12, verdict: 'PASS' });
});

test('healthRow: pass on PASS, warn on FAIL, message is the verdict line without its prefix', () => {
  const pass = core.healthRow(core.computeGreenRate(greens(12), { now: NOW }));
  assert.equal(pass.name, 'Main: green rate');
  assert.equal(pass.status, 'pass');
  assert.match(pass.message, /^rate 100% \(green 12 \/ red 0, 12 runs\), 7d trend from n\/a, day 1 of 14 at ≥80% → PASS$/);
  assert.equal(core.healthRow(core.computeGreenRate([], { now: NOW })).status, 'warn');
  assert.equal(core.healthRow(null).status, 'warn');
});

test('normalizeRuns accepts raw REST rows and assessMainRedStreak-shaped rows, drops in-progress/unparseable, sorts oldest-first', () => {
  const rows = [
    { id: 3, head_sha: 'c', conclusion: 'success', status: 'completed', created_at: '2026-09-20T10:00:00Z' },
    { id: 2, head_sha: 'b', conclusion: null, status: 'in_progress', created_at: '2026-09-20T11:00:00Z' },
    { headSha: 'a', conclusion: 'failure', createdAt: '2026-09-20T09:00:00Z' },
    { id: 9, head_sha: 'z', conclusion: 'failure', status: 'completed', created_at: 'garbage' },
  ];
  const n = core.normalizeRuns(rows);
  assert.deepEqual(n.map((r) => [r.headSha, r.color]), [['a', 'red'], ['c', 'green']]);
});

test('buildRunsApiPath pins push runs on main, completed, per_page capped, created filter percent-encoded; repo parsing', () => {
  const p = core.buildRunsApiPath({ repo: 'thomaspryor/Broadwayscore', page: 2, sinceDate: '2026-09-12' });
  assert.equal(p, 'repos/thomaspryor/Broadwayscore/actions/workflows/test.yml/runs?per_page=100&page=2&branch=main&event=push&status=completed&created=%3E%3D2026-09-12');
  assert.throws(() => core.buildRunsApiPath({ perPage: 101 }), /per_page cap/);
  assert.equal(core.windowStartDate(7, NOW), '2026-09-12');
  assert.equal(core.parseRepoFromRemote('git@github.com:thomaspryor/Broadwayscore.git\n'), 'thomaspryor/Broadwayscore');
  assert.equal(core.parseRepoFromRemote('https://github.com/thomaspryor/Broadwayscore'), 'thomaspryor/Broadwayscore');
  assert.equal(core.parseRepoFromRemote('https://gitlab.com/x/y.git'), null);
});

test('parseCliArgs: the acceptance-command shape, --k=v form, --record, and rejects bad values', () => {
  const a = core.parseCliArgs(['--days', '7', '--min', '80']);
  assert.equal(a.days, 7); assert.equal(a.min, 80); assert.equal(a.json, false); assert.equal(a.record, false);
  const b = core.parseCliArgs(['--days=1', '--json', '--record']);
  assert.equal(b.days, 1); assert.equal(b.json, true); assert.equal(b.record, true);
  const d = core.parseCliArgs([]);
  assert.equal(d.days, 7); assert.equal(d.min, 80); assert.equal(d.error, undefined);
  assert.match(core.parseCliArgs(['--days', 'x']).error, /--days must be an integer/);
  assert.match(core.parseCliArgs(['--min', '101']).error, /--min must be an integer 0-100/);
  assert.match(core.parseCliArgs(['--bogus']).error, /unknown argument/);
  assert.match(core.parseCliArgs(['--days']).error, /needs a value/);
});

test('safe-form: the acceptance command is admitted; vacuous windows/thresholds, --record and shell metachars are refused', () => {
  const ok = (c) => assert.equal(explainUnsafeCheckCommand(c).ok, true, c);
  const no = (c) => assert.equal(explainUnsafeCheckCommand(c).ok, false, c);
  ok('node scripts/ci-green-rate.js --days 7 --min 80');
  ok('node scripts/ci-green-rate.js');
  ok('node scripts/ci-green-rate.js --days 365 --min 100 --json');
  ok('node scripts/ci-green-rate.js --min 50');
  no('node scripts/ci-green-rate.js --days 1');
  no('node scripts/ci-green-rate.js --days 6');
  no('node scripts/ci-green-rate.js --min 0');
  no('node scripts/ci-green-rate.js --min 49');
  no('node scripts/ci-green-rate.js --record');
  no('node scripts/ci-green-rate.js --days 7 --min 80 --record');
  no('node scripts/ci-green-rate.js --min 80 --days 7');
  no('node scripts/ci-green-rate.js --days 7 --min 80; rm -rf /');
  no('node scripts/ci-green-rate.js --days 7 --min 80 && echo pwned');
});

test('CLI main(): exit 0 on PASS, 1 on FAIL, 2 on gh failure — never PASS when the fetch fails; --record appends exactly one ledger row', () => {
  const cli = require('../ci-green-rate.js');
  const page = (rows) => () => JSON.stringify(rows);
  const quiet = { log: () => {}, error: () => {}, repo: 'thomaspryor/Broadwayscore', ledgerRows: [] };
  const logs = [];
  const recorded = [];
  const green = greens(12);
  assert.equal(cli.main(['--days', '7', '--min', '80', '--record'], { ...quiet, now: NOW, log: (l) => logs.push(l), exec: page(green), record: (row) => recorded.push(row) }), 0);
  assert.match(logs.at(-1), /CI-GREEN-RATE: rate 100% \(green 12 \/ red 0, 12 runs\), 7d trend from n\/a, day 1 of 14 at ≥80% → PASS$/m);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].verdict, 'PASS');
  assert.equal(cli.main(['--days', '7'], { ...quiet, now: NOW, exec: page([run(1, 'failure')]) }), 1);
  assert.equal(cli.main(['--days', '7'], { ...quiet, now: NOW, exec: page([]) }), 1, 'empty window is FAIL');
  const errs = [];
  const out = [];
  const boom = () => { const e = new Error('HTTP 403'); e.stderr = 'API rate limit exceeded'; throw e; };
  assert.equal(cli.main(['--days', '7'], { ...quiet, now: NOW, log: (l) => out.push(l), error: (l) => errs.push(l), exec: boom, record: () => { throw new Error('must not record on failure'); } }), 2);
  assert.match(errs.join('\n'), /rate-limited — not retrying/);
  assert.match(out.join('\n'), /^CI-GREEN-RATE: n\/a over 7d — gh api fetch failed \(rate-limited\), no verdict$/m);
  assert.doesNotMatch(out.join('\n'), /PASS/);
  assert.equal(cli.main(['--days', 'x'], { ...quiet, exec: boom }), 2, 'usage error never reaches gh');
  assert.equal(cli.main(['--help'], { ...quiet, exec: boom }), 0, '--help never reaches gh');
  assert.equal(cli.main(['--days', '7'], { ...quiet, repo: null, exec: () => { throw new Error('no git'); } }), 2, 'unresolvable repo is exit 2, not a query against an unknown repo');
});

test('CLI fetchRuns paginates until a short page, and flags the page cap as truncated', () => {
  const cli = require('../ci-green-rate.js');
  const full = Array.from({ length: 100 }, (_, i) => run(i + 1, 'success'));
  const calls = [];
  const exec = (_gh, args) => { calls.push(args[1]); return JSON.stringify(calls.length < 3 ? full : [run(200, 'success')]); };
  const r = cli.fetchRuns({ repo: 'thomaspryor/Broadwayscore', workflow: 'test.yml', branch: 'main', days: 7, maxPages: 10, now: NOW }, exec);
  assert.equal(calls.length, 3);
  assert.equal(r.runs.length, 201);
  assert.equal(r.truncated, false);
  assert.match(calls[1], /^repos\/thomaspryor\/Broadwayscore\/.*&page=2&/);
  const capped = cli.fetchRuns({ repo: 'thomaspryor/Broadwayscore', workflow: 'test.yml', branch: 'main', days: 7, maxPages: 2, now: NOW }, () => JSON.stringify(full));
  assert.equal(capped.truncated, true);
  assert.equal(capped.runs.length, 200);
  assert.throws(() => cli.fetchRuns({ workflow: 'test.yml', branch: 'main', days: 7, maxPages: 1, now: NOW }, exec), /repo is required/);
});

test('formatReport ends with the verdict line and never says "fixed"', () => {
  const res = core.computeGreenRate([...greens(10, 30), run(5, 'success'), run(4, 'failure'), run(3, 'success')], { now: NOW });
  const text = core.formatReport(res);
  const lines = text.split('\n');
  assert.equal(lines[lines.length - 1], core.verdictLine(res));
  assert.doesNotMatch(text, /fixed/i);
  assert.match(text, /red→green latency median: 60 min \(1 sample\)/);
});

test('a cancel that ran >= HUNG_CANCEL_MIN is a hung job-timeout → RED; a short or undated cancel stays neutral (2026-09-23..24 hidden hang)', () => {
  const at = (hoursAgo, mins) => new Date(NOW - hoursAgo * H + mins * 60000).toISOString();
  const rows = [
    ...greens(10, 30),
    run(5, 'cancelled', { runStartedAt: at(5, 0), updatedAt: at(5, 20) }),  // a job's timeout-minutes hit
    run(4, 'cancelled', { runStartedAt: at(4, 0), updatedAt: at(4, 2) }),   // mid-setup cancel
    run(3.5, 'cancelled', { runStartedAt: at(3.5, 25), updatedAt: at(3.5, 27) }), // queued 25 min, ran 2 → not hung
    run(3, 'cancelled', { updatedAt: at(3, 30) }), // no run_started_at → unknown → neutral
  ];
  // Another branch/workflow: a late cancel can be a supersede — never red there.
  const other = core.computeGreenRate(rows, { now: NOW, branch: 'land/x' });
  assert.equal(other.hungCancelled, 0);
  assert.equal(other.counts.red, 0);
  const res = core.computeGreenRate(rows, { now: NOW });
  assert.equal(core.classifyConclusion('cancelled', core.HUNG_CANCEL_MIN * 60000), 'red');
  assert.equal(core.classifyConclusion('cancelled', core.HUNG_CANCEL_MIN * 60000 - 1), 'cancelled');
  assert.equal(res.counts.red, 1);
  assert.equal(res.counts.cancelled, 3);
  assert.equal(res.hungCancelled, 1);
  assert.deepEqual(res.currentStreak, { color: 'red', length: 1 }, 'a hang breaks the green streak');
  assert.match(core.verdictLine(res), /, 1 hung \(cancelled >= 10 min, counted red\)\)/);
});
