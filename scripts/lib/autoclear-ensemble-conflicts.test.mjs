import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CLASSES, findAutoClearConflicts } = require('./autoclear-ensemble-conflicts');

for (const c of CLASSES) {
  const conflict = {
    rejectionReason: c.kind,
    rejectedBy: 'ensemble-scoreability-check',
    rejectionAgreeCount: 2,
    [c.breadcrumb]: true,
  };

  test(`${c.kind}: reports an unresolved heuristic clear`, () => {
    assert.deepEqual(findAutoClearConflicts(conflict), [c]);
  });

  test(`${c.kind}: respects the standing corpus audit's explicit recovery overrides`, () => {
    for (const field of [
      'wrongProductionManualClear', 'wrongProductionOverride',
      'wrongShowManualClear', 'wrongShowOverride',
    ]) {
      assert.deepEqual(findAutoClearConflicts({ ...conflict, [field]: true }), [], field);
      assert.deepEqual(findAutoClearConflicts({ ...conflict, [field]: false }), [c], `${field}=false`);
    }
    assert.deepEqual(findAutoClearConflicts({ ...conflict, humanReviewedWrongProduction: false }), []);
  });

  test(`${c.kind}: shares exemptions for corrected URLs and rechecked production verdicts`, () => {
    assert.deepEqual(findAutoClearConflicts({
      ...conflict,
      urlCorrectedFrom: 'https://example.com/old-review',
      textFetchedAt: '2026-08-01T00:00:00Z',
      urlUpdatedAt: '2026-08-02T00:00:00Z',
    }), []);
    const rechecked = {
      ...conflict,
      rejectedAt: '2026-08-01T00:00:00Z',
      productionVerdictRecheckedAt: '2026-08-02T00:00:00Z',
    };
    assert.deepEqual(findAutoClearConflicts(rechecked), []);
    assert.deepEqual(findAutoClearConflicts({ ...rechecked, rejectedAt: '2026-08-03T00:00:00Z' }), [c]);
  });

  test(`${c.kind}: unrelated clears and automatic-clear dates do not defeat consensus`, () => {
    assert.deepEqual(findAutoClearConflicts({
      ...conflict,
      nonReviewManualClear: true,
      wrongArticleManualClear: true,
      [`${c.breadcrumb}At`]: '2026-08-01',
    }), [c]);
  });

  test(`${c.kind}: skips intact flags, absent clears and single-model verdicts`, () => {
    assert.deepEqual(findAutoClearConflicts({ ...conflict, [c.flag]: true }), []);
    assert.deepEqual(findAutoClearConflicts({ ...conflict, [c.breadcrumb]: false }), []);
    assert.deepEqual(findAutoClearConflicts({ ...conflict, rejectionAgreeCount: 1 }), []);
    assert.deepEqual(findAutoClearConflicts({ ...conflict, rejectedBy: 'manual-audit' }), []);
  });
}

test('Follies recovery retains the legacy rejection and heuristic-clear history', () => {
  // Public field shape of follies-2011/timeout--adam-feldman.json. The later
  // agent-verified recovery supersedes the older ensemble rejection.
  assert.deepEqual(findAutoClearConflicts({
    rejectionReason: 'wrong_production',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: wrong production; openai: wrong production',
    wrongProductionAutoCleared: true,
    wrongProductionAutoClearedAt: '2026-08-01',
    wrongProductionManualClear: true,
    wrongProductionOverride: true,
    wrongProductionOverrideSetAt: '2026-08-19T14:54:58.778Z',
  }), []);
});

test('missing or malformed records have no conflicts', () => {
  for (const data of [null, undefined, false, 'invalid', {}]) {
    assert.deepEqual(findAutoClearConflicts(data), []);
  }
});
