// BRO-6134: the Codex lane health decision (scripts/lib/codex-lane-health.js). Requires the real code (CLAUDE.md 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const h = require('../../scripts/lib/codex-lane-health.js');
const { toGhRuns } = require('../../scripts/codex-lane-alarm.js');

const H = 3600_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const ago = (hrs) => NOW - hrs * H;
const iso = (hrs) => new Date(ago(hrs)).toISOString();
const sum = (hrs, { slot = 0, worked = 2, landed = 'BRO-1', stop = 'no' } = {}) => ({
  createdAt: iso(hrs),
  body: `## Codex runner 2026-10-20: ${worked} card(s) worked in 100 min (slot ${slot})\n- Landed and Done: ${landed}\n- Landed part, back to Todo with what is left: none\n- Stopped early: ${stop}`,
});
const landed = (n) => Array.from({ length: n }, (_, i) => ({ ms: ago(1 + i) }));
const run = (hrs, min, conclusion = 'success') => ({ startMs: ago(hrs), durationMin: min, conclusion });
const healthy = () => ({ nowMs: NOW, landed: landed(10), summaries: [sum(1), sum(3), sum(5)], ghRuns: [run(2, 150), run(8, 140)], lockAgeH: null });
const classes = (r) => r.breaches.map((b) => `${b.lane}:${b.cls}`);

test('healthy inputs pass', () => {
  const r = h.codexLaneHealth(healthy());
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.breaches, []);
});

test('landed-low fires under the floor', () => {
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), landed: landed(2) })).includes('codex:landed-low'));
  assert.ok(!classes(h.codexLaneHealth({ ...healthy(), landed: landed(3) })).includes('codex:landed-low'));
});

test('cloud lane silent past the floor, or never seen, is a no-run breach', () => {
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), summaries: [sum(4)] })).includes('cloud:no-run'));
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), summaries: [sum(1, { slot: 3 })] })).includes('cloud:no-run'));
});

test('cloud lane that works cards but lands none for 6h breaches landed-none', () => {
  const r = h.codexLaneHealth({ ...healthy(), summaries: [sum(1, { landed: 'none' }), sum(3, { landed: 'none' }), sum(5, { landed: 'none' })] });
  assert.ok(classes(r).includes('cloud:landed-none'));
  const ok = h.codexLaneHealth({ ...healthy(), summaries: [sum(1, { landed: 'none' }), sum(3), sum(5, { landed: 'none' })] });
  assert.ok(!classes(ok).includes('cloud:landed-none'));
});

test('cloud stopped needs the NEWEST summary blocked and 2 of the last 3', () => {
  const blocked = (hrs) => sum(hrs, { stop: 'Claude usage limit reached' });
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), summaries: [blocked(1), blocked(3), sum(5)] })).includes('cloud:stopped'));
  assert.ok(!classes(h.codexLaneHealth({ ...healthy(), summaries: [sum(1), blocked(3), blocked(5)] })).includes('cloud:stopped'));
});

test('gha: two green stand-downs, silence, and two failures', () => {
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), ghRuns: [run(2, 3), run(8, 2)] })).includes('gha:stand-down'));
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), ghRuns: [run(11, 150)] })).includes('gha:no-run'));
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), ghRuns: [run(2, 150, 'failure'), run(8, 150, 'failure')] })).includes('gha:failing'));
  assert.ok(!classes(h.codexLaneHealth({ ...healthy(), ghRuns: [run(2, 3), run(8, 150)] })).includes('gha:stand-down'));
});

test('an unreadable source is unknown, not a breach, and never hides a real breach', () => {
  const r = h.codexLaneHealth({ ...healthy(), landed: null });
  assert.equal(r.status, 'unknown');
  assert.deepEqual(r.unknown, ['git landings']);
  const both = h.codexLaneHealth({ ...healthy(), landed: null, ghRuns: [run(2, 3), run(8, 2)] });
  assert.equal(both.status, 'breach');
  assert.ok(both.unknown.length === 1);
});

test('confirmation needs the same lane:class on two consecutive hourly evaluations', () => {
  // gha stand-down is present both now and an hour ago -> confirmed; landed-low only appears now -> first hour.
  const inputs = { ...healthy(), ghRuns: [run(3, 3), run(9, 2)], landed: [...landed(10).filter((e) => e.ms < NOW - 12 * H + 0), ...Array.from({ length: 3 }, (_, i) => ({ ms: ago(11.2 + i * 0.1) }))] };
  const c = h.confirmedBreaches(inputs);
  assert.ok(c.confirmed.some((b) => b.cls === 'stand-down'));
  assert.equal(c.prev.length, 1);
  const single = h.confirmedBreaches({ ...inputs, nowMs: NOW }, { consecutive: 1 });
  assert.ok(single.confirmed.length >= c.confirmed.length);
});

test('codexLandedEvents counts only Codex-runner landings', () => {
  const log = [`${ago(1)}\tCodex runner\t\tBRO-12: did a thing`, `${ago(2)}\tTom Pryor\t\tBRO-13: human`, 'garbage line'].join('\n');
  assert.equal(h.codexLandedEvents(log).length, 1);
  assert.deepEqual(h.codexLandedEvents(''), []);
});

test('toGhRuns maps the API shape and keeps null as null', () => {
  assert.equal(toGhRuns(null), null);
  const [a, b] = toGhRuns([
    { run_started_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:03:00Z', status: 'completed', conclusion: 'success' },
    { run_started_at: '2026-10-20T11:00:00Z', updated_at: '2026-10-20T11:01:00Z', status: 'in_progress', conclusion: null },
  ]);
  assert.equal(a.durationMin, 3);
  assert.equal(b.conclusion, null);
});

test('a gha run that had not ended an hour ago is unfinished in the hour-earlier check', () => {
  // Two 3-min runs: the newest started 1.5h ago and ended 1.4h ago, the older 8h ago. Both ended before "now-1h",
  // so they confirm. A run that ends 30 min ago must not count as finished at now-1h.
  const late = { startMs: ago(1.2), endMs: ago(0.5), durationMin: 3, conclusion: 'success' };
  const old = { startMs: ago(8), endMs: ago(7.9), durationMin: 3, conclusion: 'success' };
  const c = h.confirmedBreaches({ ...healthy(), ghRuns: [late, old] });
  assert.ok(c.now.breaches.some((b) => b.cls === 'stand-down'));
  assert.ok(!c.prev[0].breaches.some((b) => b.cls === 'stand-down'));
  assert.ok(!c.confirmed.some((b) => b.cls === 'stand-down'));
});

test('cloud disk-low: the newest cloud summary stopped on disk (BRO-6304), judged on the stop line only', () => {
  const full = (hrs) => sum(hrs, { worked: 0, landed: 'none', stop: 'only 1.4 GB of disk left (needs 3 GB to start a card)' });
  assert.ok(classes(h.codexLaneHealth({ ...healthy(), summaries: [full(1), sum(3), sum(5)] })).includes('cloud:disk-low'));
  assert.ok(!classes(h.codexLaneHealth({ ...healthy(), summaries: [sum(1), full(3), sum(5)] })).includes('cloud:disk-low'), 'cleared by the first healthy run');
  const quoted = { createdAt: iso(1), body: sum(1).body + '\n- Runner error mid-card (back to Todo): BRO-9 (title: fix disk of the lane, No space left on device)' };
  assert.ok(!classes(h.codexLaneHealth({ ...healthy(), summaries: [quoted, sum(3), sum(5)] })).includes('cloud:disk-low'));
});
