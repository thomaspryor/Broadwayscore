import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeContentHash,
  attemptOutcomesForCard,
  checkPark,
} = require('./attempt-memory.js');

const CARD_A = { name: 'Fix flaky date test', notes: '## Problem\nA test flakes.' };
const CARD_B = { name: 'Fix flaky date test', notes: '## Problem\nA test flakes on CI only.' };

function failEntry(cardId, ts, hash, note) {
  return { ts, event: 'card-fail', cardId, contentHash: hash, note };
}
function passEntry(cardId, ts, hash) {
  return { ts, event: 'card-pass', cardId, contentHash: hash };
}

// ── computeContentHash ──────────────────────────────────────────────────────

test('computeContentHash is stable for identical content and differs on edit', () => {
  const h1 = computeContentHash(CARD_A);
  const h2 = computeContentHash({ ...CARD_A });
  const h3 = computeContentHash(CARD_B);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test('computeContentHash never throws on a malformed/missing card', () => {
  assert.doesNotThrow(() => computeContentHash(null));
  assert.doesNotThrow(() => computeContentHash({}));
});

// ── attemptOutcomesForCard ───────────────────────────────────────────────────

test('attemptOutcomesForCard ignores entries for other cards and entries with no contentHash (pre-feature ledger lines)', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('other-card', '2026-07-28T01:00:00Z', hash, 'unrelated'),
    { ts: '2026-07-28T02:00:00Z', event: 'card-fail', cardId: 'c1', note: 'no hash — pre-feature' },
    failEntry('c1', '2026-07-28T03:00:00Z', hash, 'checks-failed: tsc'),
  ];
  const outcomes = attemptOutcomesForCard(entries, 'c1');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, 'fail');
});

test('attemptOutcomesForCard sorts chronologically regardless of ledger order', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-29T00:00:00Z', hash, 'second'),
    failEntry('c1', '2026-07-28T00:00:00Z', hash, 'first'),
  ];
  const outcomes = attemptOutcomesForCard(entries, 'c1');
  assert.deepEqual(outcomes.map(o => o.reason), ['first', 'second']);
});

// ── checkPark: the acceptance-criteria scenarios ────────────────────────────

test('failed-twice-unchanged card is parked, with the failure reasons surfaced in the reason string', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-28T02:00:00Z', hash, 'checks-failed: tsc error'),
    failEntry('c1', '2026-07-29T02:00:00Z', hash, 'checks-failed: lint error'),
  ];
  const r = checkPark(entries, 'c1', hash);
  assert.equal(r.parked, true);
  assert.equal(r.failureStreak, 2);
  assert.match(r.reason, /^parked: failed 2x unchanged/);
  assert.match(r.reason, /tsc error/);
  assert.match(r.reason, /lint error/);
});

test('a single failure does not park (threshold is 2 failures, not 1)', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [failEntry('c1', '2026-07-28T02:00:00Z', hash, 'timeout')];
  const r = checkPark(entries, 'c1', hash);
  assert.equal(r.parked, false);
  assert.equal(r.failureStreak, 1);
  assert.equal(r.reason, null);
});

test('a card with no ledger history is never parked', () => {
  const hash = computeContentHash(CARD_A);
  const r = checkPark([], 'c1', hash);
  assert.equal(r.parked, false);
  assert.equal(r.failureStreak, 0);
});

test('editing the card (content hash changes) re-enters the pool even after 2 failures on the old text', () => {
  const oldHash = computeContentHash(CARD_A);
  const newHash = computeContentHash(CARD_B);
  const entries = [
    failEntry('c1', '2026-07-28T02:00:00Z', oldHash, 'checks-failed'),
    failEntry('c1', '2026-07-29T02:00:00Z', oldHash, 'checks-failed'),
  ];
  const r = checkPark(entries, 'c1', newHash);
  assert.equal(r.parked, false);
  assert.equal(r.failureStreak, 0);
});

test('a pass between failures resets the streak — only the CONSECUTIVE unchanged run counts', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-27T02:00:00Z', hash, 'checks-failed'),
    passEntry('c1', '2026-07-28T02:00:00Z', hash),
    failEntry('c1', '2026-07-29T02:00:00Z', hash, 'checks-failed again'),
  ];
  const r = checkPark(entries, 'c1', hash);
  assert.equal(r.parked, false);
  assert.equal(r.failureStreak, 1);
});

test('3 consecutive failures still park at the default threshold (2), streak keeps counting', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-27T02:00:00Z', hash, 'a'),
    failEntry('c1', '2026-07-28T02:00:00Z', hash, 'b'),
    failEntry('c1', '2026-07-29T02:00:00Z', hash, 'c'),
  ];
  const r = checkPark(entries, 'c1', hash);
  assert.equal(r.parked, true);
  assert.equal(r.failureStreak, 3);
});

test('maxFailures is configurable', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-27T02:00:00Z', hash, 'a'),
    failEntry('c1', '2026-07-28T02:00:00Z', hash, 'b'),
  ];
  assert.equal(checkPark(entries, 'c1', hash, { maxFailures: 3 }).parked, false);
  assert.equal(checkPark(entries, 'c1', hash, { maxFailures: 1 }).parked, true);
});

// ── owner override: "clear the park" without editing the card ──────────────

test('an owner override AFTER the last failure clears the park without a content-hash change', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-27T02:00:00Z', hash, 'a'),
    failEntry('c1', '2026-07-28T02:00:00Z', hash, 'b'),
  ];
  const overrides = { c1: '2026-07-29T00:00:00Z' };
  const r = checkPark(entries, 'c1', hash, { overrides });
  assert.equal(r.parked, false);
  assert.equal(r.failureStreak, 0);
});

test('an owner override BEFORE the last failure does not clear a park that failed again afterward', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-27T02:00:00Z', hash, 'a'), // before the override
    failEntry('c1', '2026-07-30T02:00:00Z', hash, 'b'), // after the override
    failEntry('c1', '2026-07-31T02:00:00Z', hash, 'c'), // after the override
  ];
  const overrides = { c1: '2026-07-29T00:00:00Z' };
  const r = checkPark(entries, 'c1', hash, { overrides });
  // Two failures happened AFTER the override — the park re-earns itself.
  assert.equal(r.parked, true);
  assert.equal(r.failureStreak, 2);
});

test('an override for a different card does not affect this one', () => {
  const hash = computeContentHash(CARD_A);
  const entries = [
    failEntry('c1', '2026-07-27T02:00:00Z', hash, 'a'),
    failEntry('c1', '2026-07-28T02:00:00Z', hash, 'b'),
  ];
  const overrides = { 'some-other-card': '2026-07-29T00:00:00Z' };
  const r = checkPark(entries, 'c1', hash, { overrides });
  assert.equal(r.parked, true);
});
