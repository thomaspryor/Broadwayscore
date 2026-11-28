// BRO-7704: the welcome run starts right after a stored sign-up. Real functions, no copied logic (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wake = require('../../src/lib/money-welcome-wake.js');
const w = require('../../scripts/lib/money-welcome.js');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const row = (min, extra = {}) => ({ created_at: ago(min), welcomed_at: null, unsubscribed_at: null, ...extra });

test('shouldWake: only a fresh, unwelcomed, subscribed row wakes the run', () => {
  assert.equal(wake.shouldWake([row(2)], NOW), true);
  assert.equal(wake.shouldWake([row(29)], NOW), true);
  assert.equal(wake.shouldWake([row(45)], NOW), false, 'older rows are the cron\'s job');
  assert.equal(wake.shouldWake([row(2, { welcomed_at: ago(1) })], NOW), false);
  assert.equal(wake.shouldWake([row(2, { unsubscribed_at: ago(1) })], NOW), false);
  assert.equal(wake.shouldWake([], NOW), false);
  assert.equal(wake.shouldWake(null, NOW), false);
  assert.equal(wake.shouldWake([{ created_at: 'junk' }], NOW), false);
});

test('hasQueuedRun: queued or pending runs count, a running one does not', () => {
  assert.equal(wake.hasQueuedRun({ total_count: 1 }, { total_count: 0 }), true);
  assert.equal(wake.hasQueuedRun({ total_count: 0 }, { total_count: 2 }), true);
  assert.equal(wake.hasQueuedRun({ total_count: 0 }, { total_count: 0 }), false);
  assert.equal(wake.hasQueuedRun(null, null), false, 'a failed lookup must not block the dispatch');
});

// Flood guard (the P0 from the plan review): runs minutes apart must not let a slow flood drain in small batches.
test('flood guard counts the last hour, not just this run', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ email: `n${i}@real.org`, created_at: new Date().toISOString(), welcomed_at: null, unsubscribed_at: null }));
  const claimed = []; const sent = [];
  const deps = { claim: async (e) => { claimed.push(e); return true; }, release: async () => {}, send: async (r) => { sent.push(r.email); return { statusCode: 200 }; }, sleep: async () => {}, gapMs: 0 };
  const calm = await w.sendWelcomes(rows, { ...deps, recentTotal: 5 });
  assert.deepEqual([calm.flood, calm.sent], [false, 5]);
  claimed.length = 0; sent.length = 0;
  const flood = await w.sendWelcomes(rows, { ...deps, recentTotal: 80 });
  assert.deepEqual([flood.flood, flood.sent, sent.length, claimed.length], [true, 0, 0, 0]);
});

test('sendWelcomes reports the longest sign-up to welcome delay', async () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const rows = [
    { email: 'a@real.org', created_at: new Date(now - 3 * 60000).toISOString(), welcomed_at: null, unsubscribed_at: null },
    { email: 'b@real.org', created_at: new Date(now - 200 * 60000).toISOString(), welcomed_at: null, unsubscribed_at: null },
  ];
  const out = await w.sendWelcomes(rows, { claim: async () => true, release: async () => {}, send: async () => ({ statusCode: 200 }), sleep: async () => {}, gapMs: 0, now });
  assert.equal(out.max_delay_min, 200);
});
