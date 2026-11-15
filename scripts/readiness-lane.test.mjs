// BRO-7548: the readiness check must see the opening-night lane (primary Broadway publisher), the embargo time,
// and recent pipeline changes. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./lib/readiness-lane.js');

const NOW = Date.parse('2026-11-15T21:00:00Z');
const downstate = { id: 'downstate-2026', category: 'broadway', openingDate: '2026-11-15' };

test('embargo: Downstate opens reviews 2026-11-16T03:00Z, kick is 2h earlier', () => {
  const e = L.embargoFor(downstate);
  assert.equal(typeof e.embargoAt, 'string');
  assert.equal(new Date(e.embargoMs).toISOString(), '2026-11-16T03:00:00.000Z');
  assert.equal(e.kickAtMs, e.embargoMs - 120 * 60000);
  const v = L.embargoVerdict(downstate, NOW);
  assert.equal(v.status, 'pass');
  assert.match(v.detail, /in 6\.0h/);
});

test('embargo: no opening date warns instead of throwing', () => {
  assert.equal(L.embargoVerdict({ id: 'x', category: 'broadway' }, NOW).status, 'warn');
  assert.equal(L.embargoVerdict(null, NOW).status, 'warn');
});

test('arm: disarmed lane FAILS, unreadable result warns, armed passes', () => {
  assert.equal(L.armVerdict({ arm: true, reason: 'last-rehearsal-passed' }).status, 'pass');
  const off = L.armVerdict({ arm: false, reason: 'code-changed-since-rehearsal' });
  assert.equal(off.status, 'fail');
  assert.match(off.detail, /code-changed-since-rehearsal/);
  assert.equal(L.armVerdict(null).status, 'warn');
  assert.equal(L.armVerdict({}).status, 'warn');
});

const opts = (extra) => ({ showId: 'downstate-2026', night: '2026-11-15', label: 'lane night', kickAtMs: NOW + 3600000, nowMs: NOW, ...extra });

test('lane run: none yet before the kick warns, after the kick FAILS', () => {
  assert.equal(L.laneRunVerdict([], opts()).status, 'warn');
  assert.equal(L.laneRunVerdict([], opts({ kickAtMs: NOW - 1 })).status, 'fail');
});

test('lane run: other shows or nights do not count', () => {
  const runs = [
    { displayTitle: 'Opening-night lane night other-show-2026 2026-11-15', status: 'in_progress', createdAt: 'a' },
    { displayTitle: 'Opening-night lane night downstate-2026 2026-11-08', status: 'in_progress', createdAt: 'b' },
  ];
  assert.equal(L.laneRunVerdict(runs, opts()).status, 'warn');
});

test('lane run: waiting/queued/in-progress passes; green passes; failed with nothing active FAILS', () => {
  const t = 'Opening-night lane night downstate-2026 2026-11-15';
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'in_progress', createdAt: 'a' }], opts()).status, 'pass');
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'queued', createdAt: 'a' }], opts()).status, 'pass');
  assert.equal(L.laneRunVerdict([{ displayTitle: t, status: 'completed', conclusion: 'success', createdAt: 'a' }], opts()).status, 'pass');
  const dead = L.laneRunVerdict([{ displayTitle: t, status: 'completed', conclusion: 'failure', createdAt: 'a' }], opts());
  assert.equal(dead.status, 'fail');
  assert.match(dead.detail, /failure/);
  // a failed run with a newer active one behind it is fine
  assert.equal(L.laneRunVerdict([
    { displayTitle: t, status: 'in_progress', createdAt: 'b' },
    { displayTitle: t, status: 'completed', conclusion: 'cancelled', createdAt: 'a' },
  ], opts()).status, 'pass');
});

test('changes: none passes; changes with armed lane pass and are listed; changes with disarmed lane FAIL', () => {
  assert.equal(L.changesVerdict([], { armed: true, windowHours: 48 }).status, 'pass');
  const commits = [
    { sha: 'aaaaaaaa1111', subject: 'fix scorer\nbody', at: '2026-11-14T10:00:00Z' },
    { sha: 'bbbbbbbb2222', subject: 'serp tweak', at: '2026-11-15T10:00:00Z' },
  ];
  const ok = L.changesVerdict(commits, { armed: true, windowHours: 48 });
  assert.equal(ok.status, 'pass');
  assert.ok(ok.detail.indexOf('bbbbbbbb') < ok.detail.indexOf('aaaaaaaa'), 'newest first');
  assert.equal(L.changesVerdict(commits, { armed: false, windowHours: 48 }).status, 'fail');
  assert.equal(L.changesVerdict(commits, { armed: null, windowHours: 48 }).status, 'pass');
});

test('mergeCommitResponses dedupes by sha across per-path responses and tolerates junk', () => {
  const c = (sha, msg, date) => ({ sha, commit: { message: msg, committer: { date } } });
  const merged = L.mergeCommitResponses([[c('1', 'a', 'd1'), c('2', 'b', 'd2')], [c('2', 'b', 'd2'), c('3', 'c', 'd3')], null, { message: 'rate limited' }]);
  assert.deepEqual(merged.map((m) => m.sha).sort(), ['1', '2', '3']);
});

test('pipeline path list covers the lane, poller, scoring and clock', () => {
  for (const p of ['.github/workflows/opening-night-lane-live.yml', '.github/workflows/press-night-clock.yml', 'scripts/llm-scoring', 'scripts/lib/opening-night-lane']) {
    assert.ok(L.PIPELINE_PATHS.includes(p), p);
  }
});

test('nightOver: false before and during the night, true 12h after embargo, false without an embargo', () => {
  const e = L.embargoFor(downstate).embargoMs;
  assert.equal(L.nightOver(downstate, e - 3600000), false);
  assert.equal(L.nightOver(downstate, e + 11 * 3600000), false);
  assert.equal(L.nightOver(downstate, e + 13 * 3600000), true);
  assert.equal(L.nightOver({ id: 'x' }, NOW), false);
});

// Class guard: the readiness script must actually call the lane checks. Reverting the wiring (the BRO-7548 gap:
// a verdict blind to the lane) fails this.
import fs from 'node:fs';
test('check-opening-night-readiness.js is wired to the lane checks', () => {
  const src = fs.readFileSync(new URL('./check-opening-night-readiness.js', import.meta.url), 'utf8');
  for (const needle of ["require('./lib/readiness-lane')", 'RL.armVerdict', 'RL.laneRunVerdict', 'RL.changesVerdict', 'RL.embargoVerdict', 'opening-night-lane-live.yml', 'opening-night-lane-watchdog.yml', '--arm-check']) {
    assert.ok(src.includes(needle), `missing ${needle}`);
  }
});
