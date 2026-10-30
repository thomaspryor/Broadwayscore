import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const W = require('./watcher-loop.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('runLoop passes every interval until the deadline (BRO-6628)', async () => {
  const clock = fakeClock();
  const seen = [];
  const r = await W.runLoop({
    pass: async (n) => { seen.push(clock.now()); return { done: false }; },
    intervalMs: 300000, deadlineMs: 20 * 60000, ...clock,
  });
  assert.deepEqual(seen, [0, 300000, 600000, 900000]);
  assert.equal(r.reason, 'deadline');
  assert.ok(clock.now() <= 20 * 60000, 'never sleeps past the deadline');
});

test('runLoop stops as soon as a pass reports done', async () => {
  const clock = fakeClock();
  let calls = 0;
  const r = await W.runLoop({
    pass: async () => ({ done: ++calls === 2 }), intervalMs: 1000, deadlineMs: 1e9, ...clock,
  });
  assert.equal(calls, 2);
  assert.equal(r.reason, 'done');
});

test('runLoop survives a throwing pass and keeps looping', async () => {
  const clock = fakeClock();
  const logs = [];
  let calls = 0;
  const r = await W.runLoop({
    pass: async () => { calls++; if (calls === 1) throw new Error('network'); return { done: calls === 3 }; },
    intervalMs: 1000, deadlineMs: 1e9, log: (m) => logs.push(m), ...clock,
  });
  assert.equal(calls, 3);
  assert.equal(r.reason, 'done');
  assert.match(logs[0], /pass 1 failed: network/);
});

test('state: a handed-off BWW URL stops further BWW probing, a DTLI slug dispatches once', () => {
  const s = W.createWatchState();
  assert.equal(W.shouldProbeBww(s, 'x'), true);
  W.markBwwDispatched(s, 'x', 'https://bww/rr');
  assert.equal(W.shouldProbeBww(s, 'x'), false);
  assert.equal(W.shouldProbeBww(s, 'y'), true);
  assert.equal(W.shouldDispatchDtli(s, 'x', 'slug'), true);
  W.markDtliDispatched(s, 'x', 'slug');
  assert.equal(W.shouldDispatchDtli(s, 'x', 'slug'), false);
  assert.equal(W.shouldDispatchDtli(s, 'x', 'slug-2'), true, 'a CHANGED slug re-dispatches');
});

test('allDone needs both BWW and DTLI for every show', () => {
  const s = W.createWatchState();
  assert.equal(W.allDone(s, ['a', 'b']), false);
  W.markBwwDispatched(s, 'a', 'u'); W.markDtliDispatched(s, 'a', 's');
  assert.equal(W.allDone(s, ['a', 'b']), false);
  W.markBwwDispatched(s, 'b', 'u'); W.markDtliDispatched(s, 'b', 's');
  assert.equal(W.allDone(s, ['a', 'b']), true);
});

test('orchestrator starts the watcher loop before the polling loop, gated and deduped (BRO-6628)', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-orchestrator.yml'), 'utf8');
  const start = y.indexOf('- name: Start aggregator URL watcher loop');
  const poll = y.indexOf('- name: Polling loop');
  assert.ok(start > 0, 'step exists');
  assert.ok(poll > start, 'starts BEFORE the polling loop so an Express takeover cannot skip it');
  const step = y.slice(start, poll);
  assert.match(step, /steps\.find\.outputs\.has_shows == 'true'/);
  assert.match(step, /watch-aggregator-urls\.js --list-active/, 'gated on a Broadway/Off-Broadway opening today');
  assert.match(step, /endswith\("\(loop\)"\)/, 'skips only when a LOOP run is queued or running');
  assert.match(step, /gh workflow run aggregator-url-watcher\.yml -f loop_minutes=\d+/);
  assert.doesNotMatch(step, /\bsleep\b/, 'dispatches once, no polling or sleeping in the step');
});

test('watcher workflow exposes loop_minutes, titles loop runs, and bounds both modes', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/aggregator-url-watcher.yml'), 'utf8');
  assert.match(y, /loop_minutes:/);
  assert.match(y, /run-name:.*\(loop\)/);
  assert.match(y, /--loop-minutes=/);
  assert.match(y, /timeout "\$LIMIT" node scripts\/watch-aggregator-urls\.js/);
  const job = Number(/timeout-minutes:\s*(\d+)/.exec(y)[1]);
  const cap = Number(/-gt (\d+) \] && INPUT_LOOP_MINUTES=\1/.exec(y)[1]);
  assert.ok(job >= cap + 5 + 10, `job timeout ${job} covers loop cap ${cap} + setup`);
  assert.match(y, /group: aggregator-url-watcher\$\{\{[^}]*'-loop'/, 'loop runs use their own concurrency group so a cron tick cannot evict a pending loop dispatch');
});
