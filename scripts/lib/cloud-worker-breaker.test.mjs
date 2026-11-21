// Tests for the cloud worker spend breaker (BRO-6229). require()s the real module (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const brk = require('./cloud-worker-breaker.js');
const { buildClaimComment } = require('./linear-session-reporting.js');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
const claim = (model, h, id) => ({
  id,
  createdAt: ago(h),
  body: buildClaimComment({ sessionRef: 'https://claude.ai/code/session_x', ts: ago(h), workerModel: model }),
  issue: { identifier: 'BRO-1' },
});
const ADVISORY = brk.breakerConfig({});
const ENFORCE = brk.breakerConfig({ CLOUD_WORKER_BREAKER_ENFORCE: 'true' });
const P1 = { identifier: 'BRO-1', priority: 2 };
const P0 = { identifier: 'BRO-0', priority: 1 };

test('config: advisory by default, enforce and kill switch from env, caps overridable', () => {
  assert.deepEqual(ADVISORY, { mode: 'advisory', dailyCap: brk.DEFAULT_DAILY_CAP, cardAttemptCap: brk.DEFAULT_CARD_ATTEMPT_CAP });
  assert.equal(ENFORCE.mode, 'enforce');
  assert.equal(brk.breakerConfig({ CLOUD_WORKER_BREAKER_DISABLED: 'true', CLOUD_WORKER_BREAKER_ENFORCE: 'true' }).mode, 'off');
  const c = brk.breakerConfig({ CLOUD_WORKER_DAILY_CAP: '12', CLOUD_WORKER_CARD_ATTEMPT_CAP: '2' });
  assert.equal(c.dailyCap, 12);
  assert.equal(c.cardAttemptCap, 2);
  assert.equal(brk.breakerConfig({ CLOUD_WORKER_DAILY_CAP: 'abc' }).dailyCap, brk.DEFAULT_DAILY_CAP);
  assert.equal(brk.breakerConfig({ CLOUD_WORKER_DAILY_CAP: '0' }).dailyCap, brk.DEFAULT_DAILY_CAP);
});

test('only Claude-lane claims count: no-model --self claims and Codex claims are ignored', () => {
  assert.equal(brk.isClaudeLaneClaim(claim('sonnet', 1).body), true);
  assert.equal(brk.isClaudeLaneClaim(claim('opus', 1).body), true);
  assert.equal(brk.isClaudeLaneClaim(claim('codex', 1).body), false);
  assert.equal(brk.isClaudeLaneClaim(claim(null, 1).body), false);
  // A quoted body that merely mentions a worker model is not a claim.
  assert.equal(brk.isClaudeLaneClaim('Outcome: see\nWorker model: opus'), false);
});

test('daily count: 24h window, dedupes a comment fetched twice', () => {
  const rows = [claim('sonnet', 1, 'a'), claim('opus', 23.9, 'b'), claim('sonnet', 24, 'c'), claim('sonnet', 30, 'd'), claim('codex', 2, 'e'), claim('opus', 1, 'a')];
  assert.equal(brk.countDailyClaims(rows, NOW), 2);
  assert.equal(brk.countDailyClaims(null, NOW), 0);
});

test('per-card attempts count Claude-lane claims on the card within 7 days', () => {
  assert.equal(brk.cardAttempts([claim('sonnet', 100), claim('opus', 1), claim('codex', 1), { body: 'a note' }], NOW), 2);
  // Older than the window: aged out, so a skipped card comes back.
  assert.equal(brk.cardAttempts([claim('sonnet', 7 * 24), claim('opus', 200)], NOW), 0);
  assert.equal(brk.cardAttempts(undefined, NOW), 0);
});

test('under both caps: no trip', () => {
  assert.deepEqual(brk.breakerDecision({ issue: P1, dailyClaims: 5, cardAttempts: 1, config: ENFORCE }), { skip: false, wouldSkip: null, reason: null });
});

test('daily cap: advisory reports wouldSkip, enforce skips', () => {
  const cap = ADVISORY.dailyCap;
  assert.deepEqual(brk.breakerDecision({ issue: P1, dailyClaims: cap, cardAttempts: 0, config: ADVISORY }), { skip: false, wouldSkip: 'breaker-daily-cap', reason: 'breaker-daily-cap' });
  assert.deepEqual(brk.breakerDecision({ issue: P1, dailyClaims: cap, cardAttempts: 0, config: ENFORCE }), { skip: true, wouldSkip: null, reason: 'breaker-daily-cap' });
  assert.equal(brk.breakerDecision({ issue: P1, dailyClaims: cap - 1, cardAttempts: 0, config: ENFORCE }).skip, false);
});

test('per-card cap trips at the attempt cap', () => {
  const d = brk.breakerDecision({ issue: P1, dailyClaims: 0, cardAttempts: ENFORCE.cardAttemptCap, config: ENFORCE });
  assert.deepEqual(d, { skip: true, wouldSkip: null, reason: 'breaker-card-attempts' });
});

test('P0 is never blocked, in any mode, by either cap', () => {
  for (const config of [ADVISORY, ENFORCE]) {
    assert.deepEqual(brk.breakerDecision({ issue: P0, dailyClaims: 999, cardAttempts: 99, config }), { skip: false, wouldSkip: null, reason: null });
  }
});

test('kill switch: never trips, no alert', () => {
  const off = brk.breakerConfig({ CLOUD_WORKER_BREAKER_DISABLED: 'true' });
  assert.equal(brk.breakerDecision({ issue: P1, dailyClaims: 999, cardAttempts: 99, config: off }).reason, null);
  assert.equal(brk.dailyCapReached(999, off), false);
});

test('failed daily read (null) fails open; the per-card cap still applies', () => {
  assert.equal(brk.breakerDecision({ issue: P1, dailyClaims: null, cardAttempts: 0, config: ENFORCE }).skip, false);
  assert.equal(brk.dailyCapReached(null, ENFORCE), false);
  assert.equal(brk.breakerDecision({ issue: P1, dailyClaims: null, cardAttempts: 9, config: ENFORCE }).reason, 'breaker-card-attempts');
});

test('trip alert: one stable conditionKey, auto card, title names the mode; only an enforced trip asks the owner (BRO-5371)', async () => {
  const a = brk.tripAlert({ dailyClaims: 41, config: ADVISORY });
  const e = brk.tripAlert({ dailyClaims: 41, config: ENFORCE });
  assert.equal(a.conditionKey, e.conditionKey);
  assert.equal(a.conditionKey, brk.CONDITION_KEY);
  assert.equal(a.disposition, 'auto');
  assert.equal(a.verify, undefined);
  assert.doesNotMatch(a.description, /DECISION NEEDED/);
  const { buildCardNotes } = await import('node:module').then((m) => m.createRequire(import.meta.url)('./owner-alert-router.js'));
  const { findOwnerDecisions } = await import('node:module').then((m) => m.createRequire(import.meta.url)('./owner-decision-notify.js'));
  const notes = buildCardNotes({ description: e.description, conditionKey: e.conditionKey, verify: e.verify });
  const [d] = findOwnerDecisions([{ identifier: 'BRO-1', description: notes }]);
  assert.match(d.question, /keep that limit/);
  assert.match(a.title, /would have tripped/);
  assert.match(e.title, /tripped: 41/);
  assert.doesNotMatch(e.title, /would have/);
  assert.equal(brk.dailyCapReached(ADVISORY.dailyCap, ADVISORY), true);
});
