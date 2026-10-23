import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { firingStats, firingStart } = require('./worker-firing-stats.js');

const NOW = Date.parse('2026-10-23T23:00:00Z');
const claim = (iso, model = 'sonnet') => ({ body: `Claimed by https://claude.ai/code/session_x at ${iso}\nWorker model: ${model}`, createdAt: iso, issue: { identifier: 'BRO-1' } });

test('firings start at minute 47 of even UTC hours', () => {
  assert.equal(new Date(firingStart(Date.parse('2026-10-23T20:50:00Z'))).toISOString(), '2026-10-23T20:47:00.000Z');
  assert.equal(new Date(firingStart(Date.parse('2026-10-23T22:46:00Z'))).toISOString(), '2026-10-23T20:47:00.000Z');
});

test('groups Claude-lane claims per firing, ignores codex, untagged and out-of-window claims', () => {
  const s = firingStats([
    claim('2026-10-23T20:50:00Z'), claim('2026-10-23T21:10:00Z', 'opus'), claim('2026-10-23T21:15:00Z', 'codex'),
    claim('2026-10-23T18:50:00Z'),
    { body: 'Claimed by local session', createdAt: '2026-10-23T18:55:00Z' },
    claim('2026-10-10T18:50:00Z'),
  ], { nowMs: NOW });
  assert.equal(s.firings, 2);
  assert.equal(s.claims, 3);
  assert.deepEqual(s.dist, { 1: 1, 2: 1 });
  assert.equal(s.avg, 1.5);
});

test('counts firings that stopped under the cap with an hour or more left as early', () => {
  const s = firingStats([claim('2026-10-23T20:50:00Z'), claim('2026-10-23T21:00:00Z'), claim('2026-10-23T18:50:00Z'), claim('2026-10-23T19:00:00Z'), claim('2026-10-23T19:10:00Z'), claim('2026-10-23T19:40:00Z')], { nowMs: NOW });
  assert.equal(s.early, 1);
  assert.equal(s.firings, 2);
});

test('empty input is zero, not NaN', () => {
  assert.deepEqual(firingStats([], { nowMs: NOW }), { firings: 0, claims: 0, avg: 0, dist: {}, early: 0, ratio: 0 });
});

test('board-workers section 2 keeps the turn-end rule, and section 3 keeps its waiting', () => {
  const doc = readFileSync(new URL('../../docs/cloud-routines/board-workers.md', import.meta.url), 'utf8');
  const s2 = doc.slice(doc.indexOf('## 2. Claude lane'), doc.indexOf('## 3. Finish'));
  assert.match(s2, /Turn-end rule/);
  assert.match(s2, /no turn may end/);
  assert.match(doc.slice(doc.indexOf('## 3. Finish')), /wait for every land waiter/);
});

test('drops the still-running firing and the one cut by the window start, and dedupes by id', () => {
  const a = { ...claim('2026-10-23T20:50:00Z'), id: 'c1' };
  const s = firingStats([
    a, { ...a }, // same comment returned by both model queries
    claim('2026-10-23T22:50:00Z'), // firing 22:47 is still running at NOW
    claim('2026-10-20T23:10:00Z'), // firing 22:47 on the 20th starts before the 72h window
  ], { nowMs: NOW });
  assert.equal(s.firings, 1);
  assert.equal(s.claims, 1);
});
