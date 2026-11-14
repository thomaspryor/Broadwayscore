import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outletRegistryAuditExclusionBranch } = require('../../scripts/lib/outlet-registry-audit-exclusions');

for (const rejectionReason of ['wrong_show', 'wrong_production']) {
  for (const rejectedAt of [undefined, null, '', '2026-10-01T00:00:00Z']) {
    test(`${rejectionReason} is excluded with rejectedAt=${String(rejectedAt)}`, () => {
      // Keep a score so the unscored branch cannot mask a missed rejection.
      assert.equal(outletRegistryAuditExclusionBranch({
        outletId: 'new-outlet',
        humanReviewScore: 80,
        rejectionReason,
        rejectedAt,
      }), 4);
    });
  }

  for (const clear of [
    { wrongShowManualClear: true },
    { wrongShowOverride: true },
    { wrongProductionManualClear: true },
    { wrongProductionOverride: true },
    { humanReviewedWrongProduction: false },
  ]) {
    test(`${rejectionReason} respects ${Object.keys(clear)[0]} without a timestamp`, () => {
      assert.equal(outletRegistryAuditExclusionBranch({ rejectionReason, ...clear }), 0);
    });
  }
}

test('a scored review without a rejection remains in scope', () => {
  assert.equal(outletRegistryAuditExclusionBranch({ humanReviewScore: 80 }), 0);
});

test('the manual cross-show audit writer shape is excluded without rejectedAt', () => {
  assert.equal(outletRegistryAuditExclusionBranch({
    humanReviewScore: 80,
    wrongShow: true,
    isValid: false,
    rejectionReason: 'wrong_show',
    wrongShowFlaggedDate: '2026-10-01',
  }), 4);
});
