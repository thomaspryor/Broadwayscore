// LIVE-DATA-LANE: reads data/audit/press-night/a-few-good-men-2026-2026-10-29.json (read by the test); data/audit/press-night/the-imaginary-invalid-2026-2026-10-22.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6858: the watchdog replayed on two recorded press nights with their real GitHub runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replayNight, runsAt, projectNight, chainShifts } = require('../../scripts/press-night-watchdog-replay.js');
const { normalizeOutlet } = require('../../scripts/lib/review-normalization');
const norm = (o) => (o ? normalizeOutlet(String(o)) || String(o).toLowerCase() : null);
const load = (p) => JSON.parse(fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const night = (id, n) => ({ record: load(`data/audit/press-night/${id}-${n}.json`), runs: load(`tests/fixtures/press-night-watchdog-replay/runs-${id}-${n}.json`) });

test('A Few Good Men 10-29 with its real runs: the poller was moving, so no page and one late score retry', () => {
  const { record, runs } = night('a-few-good-men-2026', '2026-10-29');
  const r = replayNight({ record, runs, normOutlet: norm });
  assert.equal(r.pages.length, 0);
  assert.deepEqual(r.dispatches.map((d) => `${d.atMin}:${d.type}:${d.stage || ''}`), ['90:dispatch:score']);
});

test('A Few Good Men 10-29 with no pipeline at all: orchestrator at the embargo, page 20 min later, resolved once live', () => {
  const { record } = night('a-few-good-men-2026', '2026-10-29');
  const r = replayNight({ record, runs: null, normOutlet: norm });
  assert.equal(r.dispatches[0].type, 'dispatch-orchestrator');
  assert.deepEqual(r.pages.map((p) => p.atMin), [20]);
  assert.ok(r.acted.some((t) => t.actions.some((a) => a.type === 'resolve')));
});

test('Imaginary Invalid 10-22 with its real runs: starts the orchestrator the cron started 19 min late; no page', () => {
  const { record, runs } = night('the-imaginary-invalid-2026', '2026-10-22');
  const r = replayNight({ record, runs, normOutlet: norm });
  assert.equal(r.pages.length, 0);
  assert.deepEqual(r.dispatches.map((d) => `${d.atMin}:${d.type}`), ['0:dispatch-orchestrator', '100:dispatch']);
});

test('runsAt: a run is active between its start and its last update, unseen before it starts', () => {
  const run = { workflow: 'opening-night-poller.yml', status: 'completed', conclusion: 'success', startedAt: '2026-10-30T02:00:00Z', updatedAt: '2026-10-30T03:00:00Z' };
  assert.equal(runsAt([run], Date.parse('2026-10-30T01:59:00Z')).length, 0);
  assert.equal(runsAt([run], Date.parse('2026-10-30T02:30:00Z'))[0].status, 'in_progress');
  assert.equal(runsAt([run], Date.parse('2026-10-30T03:01:00Z'))[0].conclusion, 'success');
});

// BRO-6858 item 6: projected first-live and coverage-2h under the 5-min first-2h sleep, from the recorded runs.
test('projection, A Few Good Men 10-29: reviews ~10 min sooner, but first-live (deploy outage until +99) and coverage-2h do not move', () => {
  const { record, runs } = night('a-few-good-men-2026', '2026-10-29');
  const p = projectNight({ record, runs, normOutlet: norm });
  assert.deepEqual(p.firstLive, { recordedMin: 100, projectedMin: 100 });
  assert.equal(p.coverage2h.projectedCovered, p.coverage2h.recordedCovered);
  assert.equal(p.coverage2h.recordedCovered, 1);
  const nyt = p.shiftedReviews.find((r) => r.outletId === 'nytimes');
  assert.deepEqual(nyt, { outletId: 'nytimes', liveMin: 171, projectedMin: 161 });
  // Time Out was found at +35 but the lane only saw it published at +62: no proof it existed earlier, no gain.
  assert.ok(!p.shiftedReviews.some((r) => r.outletId === 'timeout'));
});

test('projection, Imaginary Invalid 10-22: first-live counts night reviews only (not the Oct 5 preview review); unchanged', () => {
  const { record, runs } = night('the-imaginary-invalid-2026', '2026-10-22');
  const p = projectNight({ record, runs, normOutlet: norm });
  assert.deepEqual(p.firstLive, { recordedMin: 87, projectedMin: 87 });
  assert.equal(p.coverage2h.projected, 1);
});

test('projection is Broadway only', () => {
  const { record, runs } = night('the-imaginary-invalid-2026', '2026-10-22');
  assert.match(projectNight({ record: { ...record, market: 'west-end' }, runs, normOutlet: norm }).skipped, /Broadway only/);
});

test('chainShifts: only a sleep that starts inside [embargo, +2h] is shortened; the chain inherits it; one follower each', () => {
  const E = Date.parse('2026-11-09T03:00:00Z');
  const at = (m) => new Date(E + m * 60000).toISOString();
  const run = (s, e) => ({ workflow: 'opening-night-poller.yml', status: 'completed', conclusion: 'success', startedAt: at(s), updatedAt: at(e) });
  // -80..-20 then sleep (starts before the embargo: unchanged), -5..60, sleep inside window, 75..135, sleep after +2h, 150..;
  // 152.. also starts 17 min after 135 ended, but 135 already has its follower.
  const shifts = chainShifts([run(-80, -20), run(-5, 60), run(75, 135), run(150, 210), run(152, 200)], E).map((r) => r.shift);
  assert.deepEqual(shifts, [0, 0, 10, 10, 0]);
});
