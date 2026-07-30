import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildDigest } = require('./t1-digest.js');

const HOUR = 3600000;

test('day-one grace: the inherited backlog is digest-only, 0 ACTION emails', () => {
  const now = Date.parse('2026-07-22T12:00:00Z');
  // Every cell was first-seen at/just-before rollout (the first ledger run).
  const rolloutAt = '2026-07-22T12:00:00Z';
  const ledger = { shows: {
    's1': { title: 'A', market: 'broadway', cells: {
      newsday: { state: 'GAP', firstSeenAt: '2026-05-01T00:00:00Z' },     // old gap, but firstSeen<=rollout
      broadwaynews: { state: 'GAP', firstSeenAt: '2026-07-22T11:59:59Z' },
    } },
  } };
  const { digest, actions, preRolloutCount } = buildDigest(ledger, { rolloutAt, alertedCells: [] }, now);
  assert.equal(digest.length, 2, 'both gaps appear in the digest');
  assert.equal(actions.length, 0, 'inherited backlog fires NO ACTION emails');
  assert.equal(preRolloutCount, 2);
  assert.ok(digest[0].fix.includes('gather-reviews.yml'), 'digest carries the exact fix command');
});

test('a NEW gap that crosses 24h fires exactly one ACTION; deduped on the next run', () => {
  const now = Date.parse('2026-07-25T12:00:00Z');
  const rolloutAt = '2026-07-22T12:00:00Z';
  const ledger = { shows: {
    's2': { title: 'B', market: 'broadway', cells: {
      latimes: { state: 'GAP', firstSeenAt: '2026-07-24T00:00:00Z' }, // born after rollout, now >24h
    } },
  } };
  const first = buildDigest(ledger, { rolloutAt, alertedCells: [] }, now);
  assert.equal(first.actions.length, 1, 'new >24h gap escalates');
  assert.equal(first.actions[0].outletId, 'latimes');
  // Second run with the cell recorded as alerted → deduped.
  const second = buildDigest(ledger, { rolloutAt, alertedCells: ['s2::latimes'] }, now);
  assert.equal(second.actions.length, 0, 'already-alerted gap does not re-email');
  assert.equal(second.digest.length, 1, 'still shown in the digest');
});

test('a new gap under 24h is digest-only (in-flight grace) — not an ACTION', () => {
  const now = Date.parse('2026-07-24T12:00:00Z');
  const ledger = { shows: { 's3': { title: 'C', market: 'broadway', cells: {
    variety: { state: 'GAP', firstSeenAt: new Date(now - 5 * HOUR).toISOString() },
  } } } };
  const { actions, digest } = buildDigest(ledger, { rolloutAt: '2026-07-22T12:00:00Z', alertedCells: [] }, now);
  assert.equal(digest.length, 1);
  assert.equal(actions.length, 0, 'under 24h → no ACTION yet');
});

test('non-GAP cells (IN_FLIGHT / SUPPRESSED / NO_REVIEW_EXPECTED) are not in the digest', () => {
  const now = Date.parse('2026-07-25T12:00:00Z');
  const ledger = { shows: { 's4': { title: 'D', market: 'broadway', cells: {
    wsj: { state: 'SUPPRESSED', firstSeenAt: '2026-07-24T00:00:00Z' },
    guardian: { state: 'IN_FLIGHT', firstSeenAt: '2026-07-25T06:00:00Z' },
  } } } };
  const { digest, actions } = buildDigest(ledger, { rolloutAt: '2026-07-22T12:00:00Z', alertedCells: [] }, now);
  assert.equal(digest.length, 0, 'only GAP cells are digested');
  assert.equal(actions.length, 0);
});

// --- ship-check fix: CIRCUIT_OPEN must stay VISIBLE but never ACTIONABLE -----

test('a CIRCUIT_OPEN cell IS listed in the digest (it used to vanish entirely)', () => {
  // Regression guard for the worst defect in this sprint: the breaker converted
  // GAP→CIRCUIT_OPEN and the cell then disappeared from the digest AND the
  // scoreboard, so "we quietly stopped trying" became invisible — the exact
  // silent-gap failure the v2 reconciler plan exists to eliminate.
  const ledger = { shows: { s: { title: 'S', market: 'broadway', cells: {
    nytimes: { state: 'CIRCUIT_OPEN', firstSeenAt: '2026-06-01T00:00:00.000Z' },
    vulture: { state: 'GAP', firstSeenAt: '2026-07-01T00:00:00.000Z' },
    ap: { state: 'SUPPRESSED', firstSeenAt: '2026-07-01T00:00:00.000Z' },
    ew: { state: 'IN_FLIGHT', firstSeenAt: '2026-07-29T00:00:00.000Z' },
  } } } };
  const { digest } = buildDigest(ledger, { rolloutAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-07-30T00:00:00Z'));
  const byOutlet = Object.fromEntries(digest.map((r) => [r.outletId, r]));
  assert.deepEqual(Object.keys(byOutlet).sort(), ['nytimes', 'vulture'],
    'GAP + CIRCUIT_OPEN listed; SUPPRESSED/IN_FLIGHT still excluded');
  assert.equal(byOutlet.nytimes.state, 'CIRCUIT_OPEN');
  assert.equal(byOutlet.nytimes.actionable, false);
  assert.equal(byOutlet.vulture.actionable, true);
  assert.ok(byOutlet.nytimes.ageHours > 1000, 'its age is reported, not reset');
});

test('CIRCUIT_OPEN never becomes an ACTION email, however old', () => {
  const ledger = { shows: { s: { title: 'S', market: 'broadway', cells: {
    nytimes: { state: 'CIRCUIT_OPEN', firstSeenAt: '2026-07-25T00:00:00.000Z' }, // post-rollout, >24h
  } } } };
  const { digest, actions } = buildDigest(ledger,
    { rolloutAt: '2026-07-01T00:00:00.000Z', alertedCells: [] },
    Date.parse('2026-07-30T00:00:00Z'));
  assert.equal(digest.length, 1, 'still reported');
  assert.deepEqual(actions, [], 'but never paged — the owner cannot act, and a gather would be a no-op');
});

test('CIRCUIT_OPEN fix text points at the breaker, not at another gather', () => {
  const ledger = { shows: { s: { title: 'S', market: 'broadway', cells: {
    nytimes: { state: 'CIRCUIT_OPEN', firstSeenAt: '2026-07-01T00:00:00.000Z' },
    vulture: { state: 'GAP', firstSeenAt: '2026-07-01T00:00:00.000Z' },
  } } } };
  const { digest } = buildDigest(ledger, { rolloutAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-07-30T00:00:00Z'));
  const co = digest.find((r) => r.outletId === 'nytimes');
  const gap = digest.find((r) => r.outletId === 'vulture');
  assert.match(co.fix, /circuit breaker/i);
  assert.doesNotMatch(co.fix, /gh workflow run gather-reviews/, 'must not suggest the spend the breaker just stopped');
  assert.match(gap.fix, /gh workflow run gather-reviews/, 'a real GAP still gets the gather command');
});
