// BRO-3323: branch 4 of the outlet-registry audit exclusion must key off
// rejectionReason alone. audit-cross-show-url.js --fix writes
// rejectionReason='wrong_show' WITHOUT rejectedAt, and the scoring predicate
// (review-guards explainExclusion) excludes such a file on the reason alone, so
// the audit must too or --strict trips on a review that never scores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outletRegistryAuditExclusionBranch, isExcludedFromOutletRegistryAudit } = require('./outlet-registry-audit-exclusions.js');

const base = { showId: 's-2026', outletId: 'nytimes', url: 'https://www.nytimes.com/2026/01/01/theater/x.html', fullText: 'x'.repeat(400) };

for (const reason of ['wrong_show', 'wrong_production']) {
  test(`rejectionReason=${reason} without rejectedAt is excluded (branch 4)`, () => {
    const review = { ...base, rejectionReason: reason };
    assert.equal(review.rejectedAt, undefined);
    assert.equal(outletRegistryAuditExclusionBranch(review), 4);
    assert.equal(isExcludedFromOutletRegistryAudit(review), true);
  });

  test(`rejectionReason=${reason} with rejectedAt is still excluded (branch 4)`, () => {
    assert.equal(outletRegistryAuditExclusionBranch({ ...base, rejectionReason: reason, rejectedAt: '2026-09-01T00:00:00Z' }), 4);
  });
}

test('a clean review with no rejection fields is not excluded by branch 4', () => {
  assert.notEqual(outletRegistryAuditExclusionBranch({ ...base }), 4);
});
