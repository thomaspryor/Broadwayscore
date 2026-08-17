import test from 'node:test';
import assert from 'node:assert/strict';
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
