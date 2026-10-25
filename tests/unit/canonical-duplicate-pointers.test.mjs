import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planCanonicalPointerClear,
  applyCanonicalPointerClear,
  POINTER_CLEAR_MODE,
} = require('../../scripts/lib/canonical-duplicate-pointers.js');

// The live regression this module exists for: audit-review-url-clusters.js picked
// times-uk--clive-davis.json as the byline-explosion canonical, cleared its
// duplicateOf but left duplicateTextOf pointing at the file it had just collapsed.
// review-guards.js keeps BOTH sides of a circular pair with differing fullText, so
// both landed in reviews.json under one URL and validate-data.js failed the trunk.
const CANONICAL = 'times-uk--clive-davis.json';
const COLLAPSED = 'times-uk--david-jays-and-maxie-szalwinska.json';
const ALIAS = 'times-uk--the-times.json';
const CLUSTER = [CANONICAL, COLLAPSED, ALIAS];

test('canonical-duplicate-pointers — canonical pointer clearing', async (t) => {
  await t.test('loves-labours-lost: canonical duplicateTextOf into its own cluster is dropped', () => {
    const canon = {
      duplicateOf: null,
      duplicateTextOf: COLLAPSED,
      duplicateClearReason: 'byline-explosion-canonical (byline-cluster-cleanup)',
    };
    const plan = planCanonicalPointerClear(canon, { self: CANONICAL, clusterFiles: CLUSTER });
    assert.deepEqual(plan.drop, ['duplicateTextOf']);
    assert.match(plan.reason, /back into its own byline cluster/);
  });

  await t.test('duplicateTextOf is DELETED, not nulled (validate-data flags a null one)', () => {
    assert.equal(POINTER_CLEAR_MODE.duplicateTextOf, 'delete');
    const merged = { duplicateOf: null, duplicateTextOf: COLLAPSED, url: 'https://x' };
    const changed = applyCanonicalPointerClear(
      merged,
      planCanonicalPointerClear(merged, { self: CANONICAL, clusterFiles: CLUSTER }),
    );
    assert.equal(changed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'duplicateTextOf'), false,
      'duplicateTextOf must be removed, not set to null');
    assert.equal(merged.url, 'https://x', 'unrelated fields untouched');
  });

  await t.test('duplicateOf is nulled, not deleted (long-standing on-disk shape)', () => {
    assert.equal(POINTER_CLEAR_MODE.duplicateOf, 'null');
    const merged = { duplicateOf: COLLAPSED };
    applyCanonicalPointerClear(
      merged,
      planCanonicalPointerClear(merged, { self: CANONICAL, clusterFiles: CLUSTER }),
    );
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'duplicateOf'), true);
    assert.equal(merged.duplicateOf, null);
  });

  await t.test('self-referential pointer is dropped even when clusterFiles omits self', () => {
    const canon = { duplicateTextOf: CANONICAL };
    const plan = planCanonicalPointerClear(canon, { self: CANONICAL, clusterFiles: [] });
    assert.deepEqual(plan.drop, ['duplicateTextOf']);
  });

  await t.test('with siblings: a ONE-WAY pointer into the cluster survives (syndication claim)', () => {
    // The reviewer's P0: clearing on cluster membership alone could promote a
    // genuine content-duplicate into reviews.json as a second scored review.
    // With siblings supplied, only a reciprocated pointer is a cycle.
    const siblings = {
      [CANONICAL]: { duplicateTextOf: COLLAPSED },
      [COLLAPSED]: { duplicateOf: null, duplicateTextOf: null }, // does NOT point back
    };
    const plan = planCanonicalPointerClear(siblings[CANONICAL], {
      self: CANONICAL, clusterFiles: CLUSTER, siblings,
    });
    assert.deepEqual(plan.drop, [], 'a one-way duplicateTextOf must not be cleared');
  });

  await t.test('with siblings: a RECIPROCATED pointer is cleared', () => {
    const siblings = {
      [CANONICAL]: { duplicateTextOf: COLLAPSED },
      [COLLAPSED]: { duplicateOf: CANONICAL },
    };
    const plan = planCanonicalPointerClear(siblings[CANONICAL], {
      self: CANONICAL, clusterFiles: CLUSTER, siblings,
    });
    assert.deepEqual(plan.drop, ['duplicateTextOf']);
  });

  await t.test('with siblings: an unreadable target is left alone, not assumed circular', () => {
    const siblings = { [CANONICAL]: { duplicateTextOf: COLLAPSED } }; // COLLAPSED absent
    const plan = planCanonicalPointerClear(siblings[CANONICAL], {
      self: CANONICAL, clusterFiles: CLUSTER, siblings,
    });
    assert.deepEqual(plan.drop, []);
  });

  await t.test('with siblings: a self-reference is still cleared even without reciprocity', () => {
    const siblings = { [CANONICAL]: { duplicateTextOf: CANONICAL } };
    const plan = planCanonicalPointerClear(siblings[CANONICAL], {
      self: CANONICAL, clusterFiles: CLUSTER, siblings,
    });
    assert.deepEqual(plan.drop, ['duplicateTextOf']);
  });

  await t.test('a pointer OUTSIDE the cluster is left alone (real syndication link)', () => {
    const canon = { duplicateTextOf: 'guardian--other-critic.json' };
    const plan = planCanonicalPointerClear(canon, { self: CANONICAL, clusterFiles: CLUSTER });
    assert.deepEqual(plan.drop, []);
    assert.equal(plan.reason, null);
    assert.equal(applyCanonicalPointerClear(canon, plan), false, 'no-op must not report a change');
    assert.equal(canon.duplicateTextOf, 'guardian--other-critic.json');
  });

  await t.test('both pointers into the cluster are dropped together', () => {
    const canon = { duplicateOf: ALIAS, duplicateTextOf: COLLAPSED };
    const plan = planCanonicalPointerClear(canon, { self: CANONICAL, clusterFiles: CLUSTER });
    assert.deepEqual(plan.drop, ['duplicateOf', 'duplicateTextOf']);
  });

  await t.test('non-string / empty pointers are ignored', () => {
    for (const v of [null, undefined, '', 0, false, {}]) {
      const plan = planCanonicalPointerClear({ duplicateTextOf: v }, { self: CANONICAL, clusterFiles: CLUSTER });
      assert.deepEqual(plan.drop, [], `pointer value ${JSON.stringify(v)} must not be treated as a link`);
    }
  });

  await t.test('missing data object does not throw', () => {
    assert.deepEqual(planCanonicalPointerClear(null, { self: CANONICAL, clusterFiles: CLUSTER }).drop, []);
    assert.equal(applyCanonicalPointerClear(null, { drop: ['duplicateOf'] }), false);
  });
});

// BRO-3102: the collector's fingerprint dedup must not point a canonical back
// at the loser that already points at it (2-node cycle, re-set every refetch).
test('pointsAtFile detects a sibling that already treats this file as canonical', () => {
  const { pointsAtFile } = require('../../scripts/lib/canonical-duplicate-pointers.js');
  assert.equal(pointsAtFile({ duplicateOf: 'a--wexler.json' }, 'a--wexler.json'), true);
  assert.equal(pointsAtFile({ duplicateTextOf: 'a--wexler.json' }, 'a--wexler.json'), true);
  assert.equal(pointsAtFile({ duplicateOf: 'other.json' }, 'a--wexler.json'), false);
  assert.equal(pointsAtFile(null, 'a--wexler.json'), false);
});

// BRO-5261 S11: a mutual same-text duplicateTextOf pair already on disk was
// dropped on BOTH sides by the rebuild (the plain skip ran before the circular
// tiebreak), and the collector's BRO-3102 skip never removed a back-pointer
// that was already there. Source pins on both sites; the corpus effect is
// checked by scoring-delta (Stranger Things: The First Shadow, Times).
test('rebuild lets a mutual same-text duplicateTextOf pair reach the circular tiebreak', async () => {
  // The ladder moved into duplicateTextOfDecision (BRO-5907); the rebuild
  // calls it, so pin the behaviour on the real function.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.ok(src.includes('duplicateTextOfDecision({'), 'rebuild uses the shared duplicateTextOf decision');
  const { duplicateTextOfDecision } = (await import('../../scripts/lib/duplicate-of-exclusion.js')).default;
  const pair = { staleFlag: false, refAlsoDupe: false, refExcluded: false, isCircular: true, circularSameText: true, refInheritedFlag: null, nCycle: null };
  assert.equal(duplicateTextOfDecision({ ...pair, file: 'a--x.json', target: 'b--y.json' }), null, 'smaller name survives');
  assert.equal(duplicateTextOfDecision({ ...pair, file: 'b--y.json', target: 'a--x.json' }), 'skippedCircularDuplicateTiebreak');
  assert.equal(duplicateTextOfDecision({ ...pair, isCircular: false, circularSameText: false, file: 'b--y.json', target: 'a--x.json' }), 'skippedDuplicateText');
});

test('collector drops its own stale back-pointer at a sibling that points at it', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'collect-review-texts.js'), 'utf8');
  const at = src.indexOf('if (pointsAtFile(siblingData, currentFile)) {');
  assert.ok(at > 0);
  const block = src.slice(at, at + 600);
  assert.match(block, /planCanonicalPointerClear\(data, \{ self: currentFile, clusterFiles: \[sibling\], siblings: \{ \[sibling\]: siblingData \} \}\)/);
  assert.match(block, /plan\.drop\.filter\(f => f === 'duplicateTextOf'\)/);
});

test('applying the collector plan clears only duplicateTextOf, never a loser\'s duplicateOf', () => {
  const { planCanonicalPointerClear, applyCanonicalPointerClear } = require('../../scripts/lib/canonical-duplicate-pointers.js');
  const mutual = { duplicateTextOf: 'b.json' };
  const plan = planCanonicalPointerClear(mutual, { self: 'a.json', clusterFiles: ['b.json'], siblings: { 'b.json': { duplicateTextOf: 'a.json' } } });
  applyCanonicalPointerClear(mutual, { drop: plan.drop.filter(f => f === 'duplicateTextOf') });
  assert.equal('duplicateTextOf' in mutual, false);
  const loser = { duplicateOf: 'b.json' };
  const p2 = planCanonicalPointerClear(loser, { self: 'a.json', clusterFiles: ['b.json'], siblings: { 'b.json': { duplicateTextOf: 'a.json' } } });
  applyCanonicalPointerClear(loser, { drop: p2.drop.filter(f => f === 'duplicateTextOf') });
  assert.equal(loser.duplicateOf, 'b.json');
});
