// Unit tests for the recoupment reconciler's pure decision functions.
// Per feedback_test_extraction_pattern.md — tests the real module via require(),
// not a re-implemented copy.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  MAX_VERIFY_ATTEMPTS,
  isStaleDuplicate,
  shouldAttemptVerification,
  isConfirmingVerdict,
  buildVerifiedOverlay,
} = require('../../scripts/lib/recoupment-reconcile-gate');
const { TRUSTED_RECOUPMENT_HOSTS } = require('../../scripts/lib/trusted-recoupment-domains');

describe('recoupment-reconcile-gate', () => {
  describe('isStaleDuplicate', () => {
    it('true when commercial.json already has recouped:true + a sources[].url', () => {
      assert.equal(isStaleDuplicate({
        recouped: true,
        sources: [{ type: 'trade', url: 'https://variety.com/x' }],
      }), true);
    });

    it('false when no existing entry', () => {
      assert.equal(isStaleDuplicate(null), false);
      assert.equal(isStaleDuplicate(undefined), false);
    });

    it('false when existing entry is not recouped', () => {
      assert.equal(isStaleDuplicate({ recouped: false, recoupedSource: 'Variety' }), false);
      assert.equal(isStaleDuplicate({}), false);
    });

    it('false with prose-only recoupedSource and no sources[].url (stricter than isUnsourcedRecouped)', () => {
      // audit-commercial-data.js's isUnsourcedRecouped treats a prose
      // recoupedSource as "cited enough" not to flag; the reconciler's
      // stale-dup shortcut deliberately requires a real URL before skipping
      // its own verification pass.
      assert.equal(isStaleDuplicate({ recouped: true, recoupedSource: 'Industry interviews (confirmed by 2005)' }), false);
    });

    it('false when recouped:true but uncited (real gap, not stale-dup-safe)', () => {
      assert.equal(isStaleDuplicate({ recouped: true }), false);
      assert.equal(isStaleDuplicate({ recouped: true, sources: [] }), false);
      assert.equal(isStaleDuplicate({ recouped: true, sources: [{ type: 'trade' }] }), false);
    });
  });

  describe('shouldAttemptVerification', () => {
    it('true when verifyAttempts is unset', () => {
      assert.equal(shouldAttemptVerification({}), true);
    });
    it('true below the cap', () => {
      assert.equal(shouldAttemptVerification({ verifyAttempts: 1 }), true);
    });
    it('false at or above the cap', () => {
      assert.equal(shouldAttemptVerification({ verifyAttempts: MAX_VERIFY_ATTEMPTS }), false);
      assert.equal(shouldAttemptVerification({ verifyAttempts: MAX_VERIFY_ATTEMPTS + 1 }), false);
    });
    it('respects a custom cap override', () => {
      assert.equal(shouldAttemptVerification({ verifyAttempts: 3 }, 5), true);
      assert.equal(shouldAttemptVerification({ verifyAttempts: 5 }, 5), false);
    });
  });

  describe('isConfirmingVerdict', () => {
    const goodVerdict = { recouped: true, productionMatch: 'exact', confidence: 'high' };

    it('true for exact + high-confidence + trusted host', () => {
      assert.equal(isConfirmingVerdict(goodVerdict, 'variety.com'), true);
    });

    it('false when recouped is not true', () => {
      assert.equal(isConfirmingVerdict({ ...goodVerdict, recouped: false }, 'variety.com'), false);
    });

    it('false for same-title-different-year (revival collision guard)', () => {
      assert.equal(isConfirmingVerdict({ ...goodVerdict, productionMatch: 'same-title-different-year' }, 'variety.com'), false);
    });

    it('false below high confidence', () => {
      assert.equal(isConfirmingVerdict({ ...goodVerdict, confidence: 'medium' }, 'variety.com'), false);
    });

    it('false for an untrusted host', () => {
      assert.equal(isConfirmingVerdict(goodVerdict, 'random-blog.com'), false);
    });

    it('false with no host', () => {
      assert.equal(isConfirmingVerdict(goodVerdict, ''), false);
      assert.equal(isConfirmingVerdict(goodVerdict, null), false);
    });

    it('false with no verdict', () => {
      assert.equal(isConfirmingVerdict(null, 'variety.com'), false);
    });

    it('accepts every host in TRUSTED_RECOUPMENT_HOSTS', () => {
      for (const host of TRUSTED_RECOUPMENT_HOSTS) {
        assert.equal(isConfirmingVerdict(goodVerdict, host), true, `trusted host ${host} should pass`);
      }
    });
  });

  describe('buildVerifiedOverlay', () => {
    it('shapes a scraper-compatible pending overlay', () => {
      const verdict = { recouped: true, recoupedDate: '2026-05', confidence: 'high', evidence: 'quote', articleDate: '2026-05-19' };
      const overlay = buildVerifiedOverlay({}, verdict, 'https://variety.com/x', 'variety.com');
      assert.equal(overlay.recouped, true);
      assert.equal(overlay._recoupedClaim, true);
      assert.equal(overlay.recoupedDate, '2026-05');
      assert.equal(overlay.recoupedSource, 'https://variety.com/x');
      assert.equal(overlay.sourceHost, 'variety.com');
      assert.equal(overlay.detectedBy, 'recoupment-reconciler');
      assert.equal(overlay.confidence, 'high');
      assert.equal(overlay.sources.length, 1);
      assert.equal(overlay.sources[0].url, 'https://variety.com/x');
      assert.equal(overlay.sources[0].date, '2026-05-19');
    });

    it('falls back to null recoupedDate when the verdict lacks one', () => {
      const overlay = buildVerifiedOverlay({}, { confidence: 'high' }, 'https://deadline.com/x', 'deadline.com');
      assert.equal(overlay.recoupedDate, null);
    });
  });
});
