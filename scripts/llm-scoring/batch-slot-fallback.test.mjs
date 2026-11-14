// BRO-7490: a batch still in flight must not stop a --batch run scoring new
// reviews. One batch slot means queued work is refused at submit, so the run
// scores new work synchronously, capped per run.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideDrainFollowUp, mayStartNewBatch, routeNewReview, SYNC_FALLBACK_MAX_REVIEWS } = require('../lib/batch-drain-decision.js');

test('in-flight drain tells the run to score new work synchronously', () => {
  const f = decideDrainFollowUp({ outcome: 'in-flight', manifest: [{ filePath: 'a.json' }] });
  assert.equal(f.scoreNewWorkSync, true);
  assert.equal(f.skipAllNewWork, false);
  assert.deepEqual(f.holdPaths, ['a.json']);
  // the slot really is busy: a second batch would be refused
  assert.equal(mayStartNewBatch({ submittedAt: '2026-11-13T18:46:50Z' }).allowed, false);
});

test('merged/abandoned/refused never switch new work to sync', () => {
  for (const outcome of ['merged', 'abandoned', 'refused']) {
    assert.equal(decideDrainFollowUp({ outcome }).scoreNewWorkSync, false, outcome);
  }
});

test('routeNewReview: free slot queues, busy slot scores now up to the cap, then defers', () => {
  const base = { batchMode: true, urgent: false, slotBusy: false, syncFallbackUsed: 0 };
  assert.deepEqual(routeNewReview(base), { route: 'queue', countsTowardCap: false });
  assert.deepEqual(routeNewReview({ ...base, slotBusy: true }), { route: 'sync', countsTowardCap: true });
  assert.deepEqual(routeNewReview({ ...base, slotBusy: true, syncFallbackUsed: SYNC_FALLBACK_MAX_REVIEWS - 1 }), { route: 'sync', countsTowardCap: true });
  assert.deepEqual(routeNewReview({ ...base, slotBusy: true, syncFallbackUsed: SYNC_FALLBACK_MAX_REVIEWS }), { route: 'defer', countsTowardCap: false });
});

test('routeNewReview: a simulated run never sends more than the cap to fallback scoring', () => {
  let used = 0; let deferred = 0;
  for (let i = 0; i < 400; i++) {
    const r = routeNewReview({ batchMode: true, urgent: false, slotBusy: true, syncFallbackUsed: used });
    if (r.route === 'defer') { deferred++; continue; }
    if (r.countsTowardCap) used++;
  }
  assert.equal(used, SYNC_FALLBACK_MAX_REVIEWS);
  assert.equal(deferred, 400 - SYNC_FALLBACK_MAX_REVIEWS);
});

test('routeNewReview: urgent shows and sync runs always score now, cap does not apply', () => {
  assert.deepEqual(routeNewReview({ batchMode: true, urgent: true, slotBusy: true, syncFallbackUsed: 999 }), { route: 'sync', countsTowardCap: false });
  assert.deepEqual(routeNewReview({ batchMode: false, urgent: false, slotBusy: false, syncFallbackUsed: 999 }), { route: 'sync', countsTowardCap: false });
});

test('the cap bounds a scheduled run (no --max-cost, starts after a 120-min poll)', () => {
  assert.ok(SYNC_FALLBACK_MAX_REVIEWS > 0 && SYNC_FALLBACK_MAX_REVIEWS <= 100);
});

test('index.ts wires the decision: slot flag from the drain, loop routes through routeNewReview', () => {
  const src = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(src, /batchSlotBusy = batchMode && followUp\.scoreNewWorkSync;/);
  assert.match(src, /const \{ route, countsTowardCap \} = routeNewReview\(\{/);
  assert.match(src, /if \(countsTowardCap\) syncFallbackUsed\+\+;/);
  assert.match(src, /if \(route === 'defer'\) \{\s*syncFallbackDeferred\+\+;\s*continue;/);
  assert.match(src, /if \(route === 'queue'\) \{\s*const prepared/);
  // held files are excluded before any routing decision (no double-pay)
  assert.ok(src.indexOf('if (batchHeldPaths.has(filePath))') < src.indexOf('routeNewReview({'));
  assert.doesNotMatch(src, /if \(batchMode && !urgentShowIds\.has\(reviewFile\.showId\)\) \{/);
});
