// BRO-3923 R6. Colocated test for the "Linear drain: N/day · N eligible ·
// N unarmed" morning digest row. Requires the real module (CLAUDE.md rule
// 15) — countUnarmedUrgentHigh reuses linear-watchdog-source.js's own
// ineligibleReason(), so a change to that shared eligibility gate fails
// here too instead of two definitions of "unarmed" drifting apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  doneRatePerDay,
  countUnarmedUrgentHigh,
  fetchUnarmedUrgentHighCount,
  formatDrainThroughputLine,
  isHeartbeatFresh,
  HEARTBEAT_STALE_MS,
} from './linear-drain-throughput.js';

// ---------------------------------------------------------------- doneRatePerDay

test('doneRatePerDay: divides completed by windowDays, rounded to 1 decimal', () => {
  assert.equal(doneRatePerDay(14, 7), 2);
  assert.equal(doneRatePerDay(10, 7), 1.4);
});

test('doneRatePerDay: null on missing/invalid input — never a silently wrong number', () => {
  assert.equal(doneRatePerDay(null, 7), null);
  assert.equal(doneRatePerDay(10, 0), null);
  assert.equal(doneRatePerDay(undefined, undefined), null);
});

// ship-check/Codex finding: a truncated completed-count walk is a FLOOR, not
// the real number — must render n/a, never an understated rate as exact.
test('doneRatePerDay: truncated:true forces null even with a real-looking count', () => {
  assert.equal(doneRatePerDay(14, 7, { truncated: true }), null);
  assert.equal(doneRatePerDay(14, 7, { truncated: false }), 2);
});

// ---------------------------------------------------------------- countUnarmedUrgentHigh

function issue({ priority = 1, stateType = 'unstarted', description = 'no plan here', title = 'P0: fix the thing' } = {}) {
  return { identifier: 'BRO-1', title, description, priority, state: { name: 'Todo', type: stateType }, url: 'https://linear.app/x' };
}

test('countUnarmedUrgentHigh: counts an Urgent issue with no verify command', () => {
  const count = countUnarmedUrgentHigh([issue({ priority: 1 })]);
  assert.equal(count, 1);
});

test('countUnarmedUrgentHigh: counts a High issue with no verify command', () => {
  const count = countUnarmedUrgentHigh([issue({ priority: 2 })]);
  assert.equal(count, 1);
});

test('countUnarmedUrgentHigh: an ARMED Urgent/High issue does not count', () => {
  const armed = issue({ priority: 1, description: '## Acceptance criteria\nVERIFY: node --test scripts/lib/verify-gate.test.mjs' });
  assert.equal(countUnarmedUrgentHigh([armed]), 0);
});

test('countUnarmedUrgentHigh: Medium/Low priority issues never count, armed or not', () => {
  const neutralTitle = 'fix the thing';
  assert.equal(countUnarmedUrgentHigh([
    issue({ priority: 3, title: neutralTitle }),
    issue({ priority: 4, title: neutralTitle }),
  ]), 0);
});

test('countUnarmedUrgentHigh: priority 0 with no P0/P1 title prefix is not-p0-p1, not a false Urgent', () => {
  assert.equal(countUnarmedUrgentHigh([issue({ priority: 0, title: 'fix the thing' })]), 0);
});

test('countUnarmedUrgentHigh: a started (In Progress) Urgent issue does not count — already being worked', () => {
  assert.equal(countUnarmedUrgentHigh([issue({ priority: 1, stateType: 'started' })]), 0);
});

test('countUnarmedUrgentHigh: non-array input returns null, not a thrown error or a false zero', () => {
  assert.equal(countUnarmedUrgentHigh(null), null);
  assert.equal(countUnarmedUrgentHigh(undefined), null);
});

// ---------------------------------------------------------------- fetchUnarmedUrgentHighCount

test('fetchUnarmedUrgentHighCount: no client is a reported failure, not a false zero', async () => {
  const r = await fetchUnarmedUrgentHighCount({ graphql: null });
  assert.equal(r.ok, false);
  assert.equal(r.count, null);
  assert.equal(r.reason, 'no-linear-client');
});

test('fetchUnarmedUrgentHighCount: paginates and counts across pages', async () => {
  const pages = [
    { issues: { nodes: [issue({ priority: 1 }), issue({ priority: 2, description: 'VERIFY: node --test scripts/lib/verify-gate.test.mjs' })], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
    { issues: { nodes: [issue({ priority: 2 })], pageInfo: { hasNextPage: false } } },
  ];
  let call = 0;
  const graphql = async () => pages[call++];
  const r = await fetchUnarmedUrgentHighCount({ graphql });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2, 'one unarmed on page 1, the armed one excluded, one unarmed on page 2');
});

test('fetchUnarmedUrgentHighCount: a truncated walk reports failure rather than an undercount', async () => {
  const graphql = async () => ({ issues: { nodes: [issue({ priority: 1 })], pageInfo: { hasNextPage: true, endCursor: 'more' } } });
  const r = await fetchUnarmedUrgentHighCount({ graphql, maxPages: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.count, null);
  assert.match(r.reason, /linear-scan-truncated/);
});

test('fetchUnarmedUrgentHighCount: a graphql rejection is caught and reported, never thrown', async () => {
  const graphql = async () => { throw new Error('rate limited'); };
  const r = await fetchUnarmedUrgentHighCount({ graphql });
  assert.equal(r.ok, false);
  assert.match(r.reason, /linear-fetch-failed: rate limited/);
});

// ship-check/Codex finding: a response with no GraphQL error but a
// malformed/missing issues.nodes must fail loud, not silently report 0
// unarmed issues.
test('fetchUnarmedUrgentHighCount: a malformed response (missing nodes) is a reported failure, not a false zero', async () => {
  const graphql = async () => ({ issues: {} });
  const r = await fetchUnarmedUrgentHighCount({ graphql });
  assert.equal(r.ok, false);
  assert.equal(r.count, null);
  assert.match(r.reason, /malformed-response/);
});

test('fetchUnarmedUrgentHighCount: no issues connection at all is also a reported failure', async () => {
  const graphql = async () => ({});
  const r = await fetchUnarmedUrgentHighCount({ graphql });
  assert.equal(r.ok, false);
  assert.match(r.reason, /malformed-response/);
});

// codex re-review finding: nodes present but pageInfo entirely absent must
// not read as "scan complete, 0 unarmed" — a genuinely-finished page always
// carries a real pageInfo object.
test('fetchUnarmedUrgentHighCount: nodes present but pageInfo missing entirely is a reported failure, not a false zero', async () => {
  const graphql = async () => ({ issues: { nodes: [] } });
  const r = await fetchUnarmedUrgentHighCount({ graphql });
  assert.equal(r.ok, false);
  assert.equal(r.count, null);
  assert.match(r.reason, /malformed-response/);
});

// ---------------------------------------------------------------- isHeartbeatFresh

test('isHeartbeatFresh: a recent timestamp is fresh', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  assert.equal(isHeartbeatFresh(new Date(now - 60_000).toISOString(), { nowMs: now }), true);
});

test('isHeartbeatFresh: past the stale bar is not fresh — a dead watchdog must not read as live', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  assert.equal(isHeartbeatFresh(new Date(now - HEARTBEAT_STALE_MS - 1000).toISOString(), { nowMs: now }), false);
});

test('isHeartbeatFresh: missing/unparseable timestamp is not fresh', () => {
  assert.equal(isHeartbeatFresh(null), false);
  assert.equal(isHeartbeatFresh('not-a-date'), false);
  assert.equal(isHeartbeatFresh(undefined), false);
});

// ---------------------------------------------------------------- formatDrainThroughputLine

test('formatDrainThroughputLine: renders all three numbers when everything is known', () => {
  const line = formatDrainThroughputLine({ donePerDay: 2, windowDays: 7, eligible: 12, eligibleOk: true, unarmedCount: 3 });
  assert.equal(line, 'Linear drain: 2/day Done (7d avg) · 12 Linear P0/P1 armed+eligible · 3 Urgent/High unarmed (no verify command)');
});

test('formatDrainThroughputLine: partial failure renders n/a per field, never drops the line', () => {
  const line = formatDrainThroughputLine({ donePerDay: null, windowDays: 7, eligible: null, eligibleOk: false, unarmedCount: null });
  assert.ok(line.includes('n/a Done'));
  assert.ok(line.includes('n/a Linear P0/P1'));
  assert.ok(line.includes('n/a Urgent/High unarmed'));
});

test('formatDrainThroughputLine: a stale/not-ok heartbeat renders eligible as n/a even if a number is present', () => {
  const line = formatDrainThroughputLine({ donePerDay: 1, windowDays: 7, eligible: 999, eligibleOk: false, unarmedCount: 0 });
  assert.ok(line.includes('n/a Linear P0/P1'), 'eligibleOk:false must suppress the stale number, not display it');
});
