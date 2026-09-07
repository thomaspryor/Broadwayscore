// BRO-2672: image-trigger-guard.js pure-function tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildImageDispatchInputs,
  planSelfHealDispatch,
  executeSelfHealDispatch,
  findImagelessScoredShows,
  DEFAULT_THRESHOLD_HOURS,
} = require('./image-trigger-guard.js');

test('buildImageDispatchInputs batches N shows into ONE dispatch, not N', () => {
  // Mirrors the real incident: 6 shows promoted together fired 6 separate
  // workflow_dispatch calls into a single-slot concurrency group
  // (cancel-in-progress: false) and 5 of them were silently CANCELLED.
  // A single dispatch carrying all 6 ids cannot be cancelled by its own
  // siblings, so exactly one dispatch entry must come back regardless of N.
  const showIds = ['show-a', 'show-b', 'show-c', 'show-d', 'show-e', 'show-f'];
  const dispatches = buildImageDispatchInputs(showIds);

  assert.equal(dispatches.length, 1, 'must fan into exactly one dispatch, not one per show');
  assert.equal(dispatches[0].workflow_id, 'fetch-all-image-formats.yml');
  assert.equal(dispatches[0].inputs.show_id, showIds.join(','));
  assert.equal(dispatches[0].inputs.only_missing, 'true');
});

test('buildImageDispatchInputs dedupes ids within the single dispatch', () => {
  const dispatches = buildImageDispatchInputs(['a', 'b', 'a', 'b', 'c']);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].inputs.show_id, 'a,b,c');
});

test('buildImageDispatchInputs trims whitespace and drops empty/non-string entries', () => {
  const dispatches = buildImageDispatchInputs([' show-a ', '', null, undefined, 'show-b']);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].inputs.show_id, 'show-a,show-b');
});

test('buildImageDispatchInputs returns no dispatch for an empty/missing list', () => {
  assert.deepEqual(buildImageDispatchInputs([]), []);
  assert.deepEqual(buildImageDispatchInputs(undefined), []);
  assert.deepEqual(buildImageDispatchInputs(['', '   ', null]), []);
});

test('findImagelessScoredShows flags reviewed shows past the threshold with no image', () => {
  const nowMs = Date.parse('2026-08-31T00:00:00Z');
  const staleMs = nowMs - (DEFAULT_THRESHOLD_HOURS + 1) * 3600 * 1000;
  const freshMs = nowMs - 1 * 3600 * 1000;

  const shows = [
    { id: 'stale-no-image', hasImages: false, reviewCount: 3, sinceMs: staleMs },
    { id: 'stale-has-image', hasImages: true, reviewCount: 3, sinceMs: staleMs },
    { id: 'stale-no-reviews', hasImages: false, reviewCount: 0, sinceMs: staleMs },
    { id: 'fresh-no-image', hasImages: false, reviewCount: 3, sinceMs: freshMs },
    { id: 'unresolvable-since', hasImages: false, reviewCount: 3, sinceMs: null },
  ];

  const flagged = findImagelessScoredShows(shows, { nowMs });
  assert.deepEqual(flagged.map((s) => s.id), ['stale-no-image']);
});

test('findImagelessScoredShows respects a custom thresholdHours', () => {
  const nowMs = Date.parse('2026-08-31T00:00:00Z');
  const show = { id: 'x', hasImages: false, reviewCount: 1, sinceMs: nowMs - 2 * 3600 * 1000 };
  assert.deepEqual(findImagelessScoredShows([show], { nowMs, thresholdHours: 24 }), []);
  assert.deepEqual(findImagelessScoredShows([show], { nowMs, thresholdHours: 1 }).map((s) => s.id), ['x']);
});

// ---------------------------------------------------------------------------
// The self-heal caller. BRO-2672 batched dispatch-new-show-images.js and
// closed, but audit-imageless-scored-shows.js kept dispatching one
// workflow_dispatch per show inside its own loop, so the defect the card
// describes went on happening every four hours. Observed on 2026-09-07 at
// 08:44 and 16:48 UTC: five dispatches within five seconds, three CANCELLED
// and two failed, zero successes. These cover the second caller.

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-07T18:00:00.000Z');

function flagged(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `show-${i}`, title: `Show ${i}` }));
}

test('planSelfHealDispatch: N due shows produce exactly ONE dispatch, never N', () => {
  // The whole defect in one assertion. Five due shows used to mean five
  // workflow_dispatch calls into a single-slot concurrency group, which keeps
  // one run queued and silently cancels the rest.
  for (const n of [1, 2, 5]) {
    const plan = planSelfHealDispatch({
      orderedFlagged: flagged(n),
      prevById: new Map(),
      nowMs: NOW,
      cooldownHours: 12,
      maxDispatchesPerRun: 5,
    });
    assert.equal(plan.due.length, n);
    assert.equal(plan.dispatchInputs.length, 1, `${n} due shows must still be one dispatch`);
    assert.equal(
      plan.dispatchInputs[0].inputs.show_id,
      plan.due.map((f) => f.id).join(','),
      'the single dispatch must carry every due id',
    );
  }
});

test('planSelfHealDispatch: shows past the per-run cap are deferred, not dispatched', () => {
  const plan = planSelfHealDispatch({
    orderedFlagged: flagged(8),
    prevById: new Map(),
    nowMs: NOW,
    cooldownHours: 12,
    maxDispatchesPerRun: 5,
  });
  assert.equal(plan.due.length, 5);
  assert.equal(plan.deferred.length, 3);
  assert.equal(plan.dispatchInputs.length, 1);
  assert.equal(plan.dispatchInputs[0].inputs.show_id.split(',').length, 5);
});

test('planSelfHealDispatch: a show inside its cooldown is neither due nor deferred', () => {
  const prevById = new Map([
    ['show-0', { id: 'show-0', dispatchAttempts: 1, lastDispatchedAt: new Date(NOW - 2 * HOUR).toISOString() }],
  ]);
  const plan = planSelfHealDispatch({
    orderedFlagged: flagged(2),
    prevById,
    nowMs: NOW,
    cooldownHours: 12,
    maxDispatchesPerRun: 5,
  });
  assert.deepEqual(plan.due.map((f) => f.id), ['show-1']);
  assert.deepEqual(plan.deferred, []);
});

test('planSelfHealDispatch: entries carry prior attempt history forward untouched', () => {
  // The planner must NOT advance dispatchAttempts or lastDispatchedAt — the
  // caller does that only after a dispatch actually succeeds. The old code
  // stamped both for every show in a burst, including the four whose runs were
  // cancelled, and the cooldown then suppressed the retry for work that never
  // happened.
  const prevById = new Map([
    ['show-0', { id: 'show-0', firstFlaggedAt: '2026-09-01T00:00:00.000Z', dispatchAttempts: 2, lastDispatchedAt: '2026-09-01T00:00:00.000Z' }],
  ]);
  const plan = planSelfHealDispatch({
    orderedFlagged: flagged(1),
    prevById,
    nowMs: NOW,
    cooldownHours: 12,
    maxDispatchesPerRun: 5,
  });
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].dispatchAttempts, 2, 'planner must not bump the counter');
  assert.equal(plan.entries[0].lastDispatchedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(plan.entries[0].firstFlaggedAt, '2026-09-01T00:00:00.000Z', 'first-flagged history preserved');
});

test('planSelfHealDispatch: an empty due set produces no dispatch at all', () => {
  const prevById = new Map([
    ['show-0', { id: 'show-0', dispatchAttempts: 1, lastDispatchedAt: new Date(NOW - HOUR).toISOString() }],
  ]);
  const plan = planSelfHealDispatch({
    orderedFlagged: flagged(1),
    prevById,
    nowMs: NOW,
    cooldownHours: 12,
    maxDispatchesPerRun: 5,
  });
  assert.deepEqual(plan.dispatchInputs, [], 'nothing due must mean nothing dispatched');
  assert.equal(plan.entries.length, 1, 'the ledger row still has to be written');
});

// ---------------------------------------------------------------------------
// The EXECUTION seam. A pre-ship review of the first version of this fix made
// the point that planner-only tests all stay green if the caller quietly goes
// back to its own per-show loop — so the loop has to be gone from the caller
// and the dispatch count has to be asserted where the dispatch actually
// happens. These drive executeSelfHealDispatch() with a stubbed dispatcher.

function spyDispatch(result) {
  const calls = [];
  const fn = async (ids) => { calls.push(ids); return result; };
  fn.calls = calls;
  return fn;
}

function planFor(n, prev = new Map()) {
  return planSelfHealDispatch({
    orderedFlagged: flagged(n),
    prevById: prev,
    nowMs: NOW,
    cooldownHours: 12,
    maxDispatchesPerRun: 5,
  });
}

test('executeSelfHealDispatch: five due shows call the dispatcher exactly ONCE', async () => {
  // The defect, measured where it happened. The old caller awaited a dispatch
  // per show inside its loop, so this count was 5 and four of the five runs
  // were cancelled by the single-slot concurrency group before they started.
  const dispatch = spyDispatch({ ok: true });
  const plan = planFor(5);
  const out = await executeSelfHealDispatch({ plan, dispatch, nowMs: NOW });
  assert.equal(dispatch.calls.length, 1, 'five shows must be ONE workflow_dispatch');
  assert.equal(out.dispatchCalls, 1);
  assert.equal(dispatch.calls[0].split(',').length, 5, 'the one call carries all five ids');
  assert.equal(out.dispatched.length, 5);
});

test('executeSelfHealDispatch: a FAILED dispatch starts no cooldown and no attempt (BRO-2672 second caller)', async () => {
  // The compounding half of the bug: the old caller stamped lastDispatchedAt
  // for every show in the burst, including the four whose runs were cancelled,
  // so the 12h cooldown then suppressed the retry and the ledger recorded
  // attempts for images that were never fetched.
  const dispatch = spyDispatch({ ok: false, error: 'no-token' });
  const plan = planFor(3);
  const out = await executeSelfHealDispatch({ plan, dispatch, nowMs: NOW });
  assert.equal(out.ok, false);
  assert.deepEqual(out.dispatched, [], 'nothing may be marked dispatched');
  for (const entry of plan.entries) {
    assert.equal(entry.dispatchAttempts || 0, 0, `${entry.id} must not have an attempt recorded`);
    assert.equal(entry.lastDispatchedAt ?? null, null, `${entry.id} must not enter cooldown`);
  }
});

test('executeSelfHealDispatch: a successful dispatch bumps every carried show exactly once', async () => {
  const prev = new Map([['show-0', { id: 'show-0', dispatchAttempts: 2, lastDispatchedAt: null }]]);
  const dispatch = spyDispatch({ ok: true });
  const plan = planFor(2, prev);
  await executeSelfHealDispatch({ plan, dispatch, nowMs: NOW });
  const byId = Object.fromEntries(plan.entries.map((e) => [e.id, e]));
  assert.equal(byId['show-0'].dispatchAttempts, 3, 'prior history is carried, then bumped once');
  assert.equal(byId['show-1'].dispatchAttempts, 1);
  assert.equal(byId['show-0'].lastDispatchedAt, new Date(NOW).toISOString());
});

test('executeSelfHealDispatch: failure alerts stay keyed PER SHOW, not per batch', async () => {
  // One global condition key would let a later batch of entirely different
  // shows be silenced behind this batch's 24h alert cooldown (review finding).
  const alerts = [];
  const dispatch = spyDispatch({ ok: false, error: '403 forbidden' });
  const plan = planFor(3);
  await executeSelfHealDispatch({
    plan, dispatch, nowMs: NOW,
    onAlert: async (a) => { alerts.push(a); },
  });
  assert.equal(alerts.length, 3, 'one alert per affected show');
  assert.deepEqual(alerts.map((a) => a.show.id).sort(), ['show-0', 'show-1', 'show-2']);
  for (const a of alerts) {
    assert.equal(a.error, '403 forbidden');
    assert.equal(a.batchIds.split(',').length, 3, 'each alert still names the batch it rode in');
  }
});

test('executeSelfHealDispatch: nothing due means the dispatcher is never called at all', async () => {
  const prev = new Map([['show-0', { id: 'show-0', dispatchAttempts: 1, lastDispatchedAt: new Date(NOW - HOUR).toISOString() }]]);
  const dispatch = spyDispatch({ ok: true });
  const plan = planFor(1, prev);
  const out = await executeSelfHealDispatch({ plan, dispatch, nowMs: NOW });
  assert.equal(dispatch.calls.length, 0);
  assert.equal(out.dispatchCalls, 0);
  assert.equal(out.ok, null, 'no dispatch means no verdict, not a false success');
});
