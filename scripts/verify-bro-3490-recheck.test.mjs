/**
 * verify-bro-3490-recheck.test.mjs — the RECHECK-AFTER acceptance command for
 * BRO-3490's live outcome: the six closed shows the stale-closure classifier
 * was stuck on (all "deep research never ran") get researched by the next
 * Saturday deep-research run, now that deep-research-commercial.js ranks
 * closed never-researched TBD shows right after its queue.
 *
 * Asserts against LIVE data (data/commercial.json + data/shows.json) through
 * the real staleClosuresNeedingResearch. Skipped before CHECKABLE_FROM: the
 * claim cannot be true until Saturday's run, and land's colocated-tests gate
 * runs every test a branch adds (scripts/lib/autonomous-checks.js), so a probe
 * that is red by design would refuse its own landing. The recheck only runs
 * it after the card's RECHECK-AFTER date, when the skip no longer applies. Top-level scripts/verify-* are
 * not collected into CI (scripts/lib/unit-test-collection.js OPT_IN), so this
 * only runs from scripts/autonomous-acceptance-recheck.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { staleClosuresNeedingResearch } = require('./lib/commercial-queue.js');

const STUCK_ON_2026_10_13 = [
  'joe-turners-come-and-gone', 'beaches', 'the-fear-of-13',
  'death-of-a-salesman', 'dog-day-afternoon', 'celebrity-autobiography',
];

const CHECKABLE_FROM = Date.parse('2026-10-18T00:00:00Z'); // = the card's RECHECK-AFTER

test('the six stale-closure shows stuck on 2026-10-13 have been researched', {
  skip: Date.now() < CHECKABLE_FROM ? 'claim not checkable before 2026-10-18 (next deep-research run is Saturday 2026-10-17)' : false,
}, () => {
  const comm = require('../data/commercial.json').shows || {};
  const sj = require('../data/shows.json');
  const still = new Set(staleClosuresNeedingResearch(sj.shows || sj, comm));
  const left = STUCK_ON_2026_10_13.filter((s) => still.has(s));
  assert.deepEqual(left, [], `still never researched: ${left.join(', ')}`);
});
