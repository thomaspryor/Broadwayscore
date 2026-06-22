/**
 * Guards the self-healing review-recovery decision logic in
 * scripts/lib/flagged-recovery.js — the merge-safe empty-body subset that the
 * hourly audit-aggregator-gap loop re-ingests automatically.
 *
 * Why this exists (Notion 387637c5-416f-81c6): new openings land "short" because
 * paywalled reviews get a discovered URL but an empty fetched body, so the file
 * exists yet never becomes includable (Glengarry WE empty Times review). The
 * recovery loop re-fetches the aggregator's current-production URL and MERGES the
 * text in. This freezes the four safety contracts:
 *   1. empty-body, in-window, no flags  → recover
 *   2. dead URL → aggUrlRecoveryCount hits cap 3 → STOP (no infinite re-fetch / credit burn)
 *   3. correct prior-production exclusion (wrongProduction) → NEVER re-fetched
 *   4. human-protected file (humanReviewScore / manual clear / verified production) → NEVER touched
 *
 * Per CLAUDE.md §15 we require() the real decision functions — production changes
 * that weaken any guard fail this test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  FLAGGED_RECOVERY_CAP,
  isEmptyBodyFile,
  isRecoverableFlaggedFile,
  decideEmptyBodyRecovery,
  nextRecoveryCount,
} = require('../../scripts/lib/flagged-recovery.js');

const AGG_URL = 'https://www.thetimes.com/article/glengarry-2026-review';

describe('flagged-recovery: empty-body detection', () => {
  test('absent / short / whitespace fullText is empty-body', () => {
    assert.equal(isEmptyBodyFile({}), true);
    assert.equal(isEmptyBodyFile({ fullText: '' }), true);
    assert.equal(isEmptyBodyFile({ fullText: 'x'.repeat(399) }), true);
  });

  test('400+ char body is NOT empty-body', () => {
    assert.equal(isEmptyBodyFile({ fullText: 'x'.repeat(400) }), false);
  });

  test('aggregator stars or an assigned score count as non-empty (scoreable)', () => {
    assert.equal(isEmptyBodyFile({ fullText: '', aggregatorStars: 4 }), false);
    assert.equal(isEmptyBodyFile({ fullText: '', assignedScore: 80 }), false);
  });
});

describe('flagged-recovery: isRecoverableFlaggedFile', () => {
  test('1. empty-body in-window file IS recoverable', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '' }), true);
  });

  test('2. dead URL stops at the cap (3 tries)', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '', aggUrlRecoveryCount: 2 }), true);  // 3rd try allowed
    assert.equal(isRecoverableFlaggedFile({ fullText: '', aggUrlRecoveryCount: 3 }), false); // cap reached
    assert.equal(isRecoverableFlaggedFile({ fullText: '', aggUrlRecoveryCount: 9 }), false);
    assert.equal(FLAGGED_RECOVERY_CAP, 3);
  });

  test('3. wrongProduction / wrongShow file is NEVER recoverable (correct prior-production exclusion)', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongProduction: true }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongShow: true }), false);
  });

  test('4. human-protected file is NEVER recoverable', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '', humanReviewScore: 75 }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongProductionManualClear: true }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongShowManualClear: true }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', humanReviewedWrongProduction: false }), false);
  });

  test('a healed (full-body) file is not recoverable — nothing to do', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: 'x'.repeat(2000) }), false);
  });
});

describe('flagged-recovery: decideEmptyBodyRecovery', () => {
  test('recoverable empty-body → recover, carrying outlet/critic/url for same-slug merge', () => {
    const d = decideEmptyBodyRecovery({
      file: { fullText: '', aggUrlRecoveryCount: 0 },
      outletId: 'times-uk',
      critic: 'Clive Davis',
      url: AGG_URL,
    });
    assert.equal(d.action, 'recover');
    assert.equal(d.reason, 'empty-body-merge-safe');
    assert.equal(d.outletId, 'times-uk');
    assert.equal(d.critic, 'Clive Davis');
    assert.equal(d.url, AGG_URL);
  });

  test('missing aggregator URL → skip (nothing to re-fetch)', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: '' }, outletId: 'times-uk', url: null });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-aggregator-url');
  });

  test('cap reached → skip with cap-reached reason', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: '', aggUrlRecoveryCount: 3 }, url: AGG_URL });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'cap-reached');
  });

  test('wrongProduction → skip, reason names the exclusion (never re-fetched)', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: '', wrongProduction: true }, url: AGG_URL });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'wrong-production-or-show');
  });

  test('human-protected → skip (never touched)', () => {
    assert.equal(decideEmptyBodyRecovery({ file: { fullText: '', humanReviewScore: 80 }, url: AGG_URL }).reason, 'human-protected');
    assert.equal(decideEmptyBodyRecovery({ file: { fullText: '', wrongProductionManualClear: true }, url: AGG_URL }).reason, 'manual-clear');
    assert.equal(decideEmptyBodyRecovery({ file: { fullText: '', humanReviewedWrongProduction: false }, url: AGG_URL }).reason, 'human-verified-production');
  });

  test('full-body file → skip not-empty-body (no redundant re-fetch)', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: 'x'.repeat(2000) }, url: AGG_URL });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'not-empty-body');
  });
});

describe('flagged-recovery: nextRecoveryCount (cap is persisted every attempt)', () => {
  test('monotonic increment from undefined / 0 / N', () => {
    assert.equal(nextRecoveryCount(undefined), 1);
    assert.equal(nextRecoveryCount({}), 1);
    assert.equal(nextRecoveryCount({ aggUrlRecoveryCount: 0 }), 1);
    assert.equal(nextRecoveryCount({ aggUrlRecoveryCount: 2 }), 3);
  });

  test('after CAP failed attempts the file is no longer recoverable', () => {
    // Simulate the loop: start empty, fail-fetch CAP times, bumping the counter each time.
    let file = { fullText: '' };
    for (let i = 0; i < FLAGGED_RECOVERY_CAP; i++) {
      assert.equal(isRecoverableFlaggedFile(file), true, `try ${i + 1} should still be recoverable`);
      file = { ...file, aggUrlRecoveryCount: nextRecoveryCount(file) };
    }
    assert.equal(isRecoverableFlaggedFile(file), false, 'after CAP tries it must stop');
    assert.equal(file.aggUrlRecoveryCount, FLAGGED_RECOVERY_CAP);
  });
});
