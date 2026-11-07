// BRO-44 — sessions_engaged headline KPI aggregation.
// Run: node --test scripts/lib/ga4-engaged-sessions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { summarizeChannelRows } = require('./ga4-engaged-sessions.js');

test('headline is total engaged sessions across all channels', () => {
  const summary = summarizeChannelRows([
    { channel: 'Direct', sessions: 25000, engagedSessions: 1500 },
    { channel: 'Organic Search', sessions: 5000, engagedSessions: 3200 },
    { channel: 'Referral', sessions: 2168, engagedSessions: 980 },
  ]);
  assert.strictEqual(summary.totalSessions, 32168);
  assert.strictEqual(summary.totalEngagedSessions, 5680);
  assert.strictEqual(summary.headline, 5680);
});

test('reports Direct-channel bot signature separately from the ex-Direct totals', () => {
  const summary = summarizeChannelRows([
    { channel: 'Direct', sessions: 25000, engagedSessions: 1500 },
    { channel: 'Organic Search', sessions: 5000, engagedSessions: 3200 },
  ]);
  assert.strictEqual(summary.direct.sessions, 25000);
  assert.strictEqual(summary.sessionsExDirect, 5000);
  assert.strictEqual(summary.engagedSessionsExDirect, 3200);
});

test('inflation ratio compares raw sessions to the engaged headline', () => {
  const summary = summarizeChannelRows([
    { channel: 'Direct', sessions: 25000, engagedSessions: 1500 },
    { channel: 'Organic Search', sessions: 5000, engagedSessions: 3200 },
    { channel: 'Referral', sessions: 2168, engagedSessions: 980 },
  ]);
  assert.ok(Math.abs(summary.inflationRatio - 32168 / 5680) < 1e-9);
});

test('missing Direct channel defaults to zero rather than throwing', () => {
  const summary = summarizeChannelRows([
    { channel: 'Organic Search', sessions: 5000, engagedSessions: 3200 },
  ]);
  assert.strictEqual(summary.direct.sessions, 0);
  assert.strictEqual(summary.direct.engagedSessions, 0);
  assert.strictEqual(summary.sessionsExDirect, 5000);
});

test('zero engaged sessions yields a null inflation ratio instead of Infinity', () => {
  const summary = summarizeChannelRows([
    { channel: 'Direct', sessions: 1000, engagedSessions: 0 },
  ]);
  assert.strictEqual(summary.totalEngagedSessions, 0);
  assert.strictEqual(summary.inflationRatio, null);
});

test('empty row set never throws', () => {
  const summary = summarizeChannelRows([]);
  assert.strictEqual(summary.totalSessions, 0);
  assert.strictEqual(summary.headline, 0);
  assert.strictEqual(summary.inflationRatio, null);
});
