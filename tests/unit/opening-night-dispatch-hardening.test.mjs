import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wd = require('../../scripts/lib/press-night-watchdog');
const collection = require('../../scripts/lib/poller-needs-collection');
const sweep = require('../../scripts/lib/post-lane-sweep');
const NOW = Date.parse('2026-11-12T12:00:00Z');
const review = { url: 'https://example.org/review', contentTier: 'stub', firstSeenAt: '2026-11-12T10:00:00Z' };

test('collection excludes marked paywalls and old or undated stubs, preserving recent recoverable text', () => {
  const needs = (r) => collection.reviewNeedsCollection(r, new Map(), { nowMs: NOW });
  assert.equal(needs(review), true);
  assert.equal(needs({ ...review, incompleteReason: 'paywall', contentTier: 'excerpt' }), false);
  assert.equal(needs({ ...review, firstSeenAt: '2026-11-01T00:00:00Z' }), false);
  assert.equal(needs({ ...review, firstSeenAt: null }), false);
  assert.equal(needs({ ...review, firstSeenAt: 'bad date', collectedAt: '2026-11-12T10:00:00Z' }), true);
  assert.equal(needs({ ...review, firstSeenAt: '2026-11-05T12:00:00Z' }), false, 'seven day boundary');
  assert.equal(needs({ ...review, firstSeenAt: '2026-11-13T00:00:00Z' }), false, 'future stamp');
  assert.equal(needs({ ...review, contentTier: 'truncated' }), true);
  assert.equal(needs({ ...review, contentTier: 'complete' }), false);
});

function ports(overrides = {}) {
  const calls = [];
  return { calls, claim: () => ({ ok: true }),
    dispatch: () => { calls.push('dispatch'); throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }); },
    reconcile: () => { calls.push('list'); return true; },
    mark: () => { calls.push('mark'); return { ok: true }; },
    unclaim: () => { calls.push('unclaim'); return { ok: true }; },
    ...overrides };
}

test('a timeout accepted by GitHub is reconciled before any resend or unclaim', () => {
  const p = ports();
  const result = wd.claimThenDispatch(p);
  assert.equal(result.sent, true);
  assert.equal(result.spent, true);
  assert.deepEqual(p.calls, ['dispatch', 'list', 'mark']);
});

test('unknown acceptance retains the slot even when the run list is empty or unavailable', () => {
  for (const reconcile of [() => false, () => { throw new Error('offline'); }]) {
    const p = ports({ reconcile });
    const result = wd.claimThenDispatch(p);
    assert.equal(result.sent, false);
    assert.equal(result.spent, true);
    assert.equal(result.uncertain, true);
    assert.deepEqual(p.calls, ['dispatch', 'mark']);
  }
});

test('a definite dispatch rejection releases its claim for another attempt', () => {
  const p = ports({ dispatch: () => { throw new Error('HTTP 422: invalid input'); } });
  const result = wd.claimThenDispatch(p);
  assert.equal(result.spent, false);
  assert.deepEqual(p.calls, ['unclaim']);
});

test('contended claims retry, dispatch once on success, and remain retryable on exhaustion', () => {
  let attempts = 0, sends = 0;
  const p = ports({ claim: () => ++attempts < 3 ? { ok: false, reason: 'cas-contended' } : { ok: true },
    dispatch: () => { sends++; return true; } });
  assert.equal(wd.claimThenDispatch(p).sent, true);
  assert.equal(attempts, 3);
  assert.equal(sends, 1);
  attempts = 0;
  const failed = wd.claimThenDispatch(ports({ claim: () => { attempts++; return { ok: false, reason: 'cas-contended' }; } }));
  assert.equal(attempts, 3);
  assert.equal(failed.spent, false);
  assert.equal(sweep.dispatchExitCode(failed), 1, 'clock must not mark an unsent slot fired');
  assert.equal(sweep.dispatchExitCode({ sent: false, spent: false, reason: 'not claimed (claim-in-flight)' }), 1);
  assert.equal(sweep.dispatchExitCode({ sent: false, spent: true }), 0);
});

test('timeout reconciliation polls boundedly for delayed run visibility without resending', () => {
  let lists = 0, sends = 0;
  const waits = [];
  const result = wd.dispatchWithRecovery({
    dispatch: () => { sends++; throw new Error('HTTP 502'); },
    reconcile: () => ++lists === 3,
    wait: (ms) => waits.push(ms),
  });
  assert.equal(result.sent, true);
  assert.equal(sends, 1);
  assert.equal(lists, 3);
  assert.deepEqual(waits, [5000, 10000]);
});

test('run reconciliation rejects old, auto, other-show and other-workflow runs', () => {
  const workflow = 'opening-night-poller.yml';
  const run = { workflow, displayTitle: 'Opening Night Poller \u2014 wanted-2022', createdAt: new Date(NOW).toISOString() };
  const find = (runs) => wd.findDispatchedRun(runs, { workflow, showId: 'wanted-2022', sinceMs: NOW });
  assert.equal(find([{ ...run, createdAt: new Date(NOW - 1000).toISOString() }]), undefined);
  assert.equal(find([{ ...run, displayTitle: 'Opening Night Poller \u2014 auto' }]), undefined);
  assert.equal(find([{ ...run, displayTitle: 'Opening Night Poller \u2014 other-show' }]), undefined);
  assert.equal(find([{ ...run, workflow: 'other.yml' }]), undefined);
  assert.equal(find([run]), run);
});

test('the production reconciliation port reads dispatch runs with one REST request', () => {
  const calls = [];
  const result = wd.reconcileDispatchRun({ workflow: 'opening-night-poller.yml', showId: 'wanted-2022', sinceMs: NOW,
    gh: (args) => {
      calls.push(args);
      return JSON.stringify({ workflow_runs: [{ display_title: 'Opening Night Poller \u2014 wanted-2022', created_at: new Date(NOW).toISOString() }] });
    },
  });
  assert.ok(result);
  assert.deepEqual(calls, [['api', 'repos/thomaspryor/Broadwayscore/actions/workflows/opening-night-poller.yml/runs?per_page=60&event=workflow_dispatch']]);
});
