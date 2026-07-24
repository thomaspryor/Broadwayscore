// scripts/lib/orphan-rescore-requeue.test.mjs — node:test
// Run: node --test scripts/lib/orphan-rescore-requeue.test.mjs
//
// Pure decision function for #356 (orphan-unscored self-heal). Per CLAUDE.md
// §15 — extracted from scripts/dispatch-orphan-rescore-requeue.js so state
// I/O and dispatch/alert side effects stay out of the tested logic.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideRequeueAction, DEFAULT_COOLDOWN_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_WINDOW_MS } from './orphan-rescore-requeue.js';

const NOW = new Date('2026-07-23T12:00:00.000Z');

test('no prior attempts -> dispatch immediately', () => {
  const result = decideRequeueAction([], NOW);
  assert.equal(result.action, 'dispatch');
  assert.deepEqual(result.recentAttempts, []);
});

test('one attempt inside cooldown -> wait', () => {
  const attempts = [{ at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(), ok: true }];
  const result = decideRequeueAction(attempts, NOW);
  assert.equal(result.action, 'wait');
  assert.ok(result.waitMs > 0 && result.waitMs <= DEFAULT_COOLDOWN_MS);
});

test('one attempt past cooldown -> dispatch again', () => {
  const attempts = [{ at: new Date(NOW.getTime() - 61 * 60 * 1000).toISOString(), ok: false }];
  const result = decideRequeueAction(attempts, NOW);
  assert.equal(result.action, 'dispatch');
});

test('max attempts reached within window -> alert', () => {
  const attempts = [
    { at: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(), ok: true },
    { at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), ok: false },
  ];
  const result = decideRequeueAction(attempts, NOW);
  assert.equal(result.action, 'alert');
  assert.equal(result.recentAttempts.length, DEFAULT_MAX_ATTEMPTS);
});

test('attempts older than the rolling window are ignored -> dispatch resumes', () => {
  const attempts = [
    { at: new Date(NOW.getTime() - (DEFAULT_WINDOW_MS + 60 * 60 * 1000)).toISOString(), ok: false },
    { at: new Date(NOW.getTime() - (DEFAULT_WINDOW_MS + 30 * 60 * 1000)).toISOString(), ok: false },
  ];
  const result = decideRequeueAction(attempts, NOW);
  assert.equal(result.action, 'dispatch');
  assert.deepEqual(result.recentAttempts, []);
});

test('malformed attempt timestamps are dropped, not counted', () => {
  const attempts = [{ at: 'not-a-date', ok: true }, { at: undefined, ok: true }];
  const result = decideRequeueAction(attempts, NOW);
  assert.equal(result.action, 'dispatch');
  assert.deepEqual(result.recentAttempts, []);
});

test('custom opts override defaults (maxAttempts=1 alerts on first recent attempt)', () => {
  const attempts = [{ at: new Date(NOW.getTime() - 61 * 60 * 1000).toISOString(), ok: false }];
  const result = decideRequeueAction(attempts, NOW, { maxAttempts: 1 });
  assert.equal(result.action, 'alert');
});

test('exactly at cooldown boundary resolves to dispatch (strict less-than in the wait check)', () => {
  const attempts = [{ at: new Date(NOW.getTime() - DEFAULT_COOLDOWN_MS).toISOString(), ok: true }];
  const result = decideRequeueAction(attempts, NOW);
  assert.equal(result.action, 'dispatch');
});
