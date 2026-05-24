// Unit tests for the apply-commercial-pending decision gate.
// Per feedback_test_extraction_pattern.md — tests the real module via require(),
// not a re-implemented copy.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const gate = require('../../scripts/lib/commercial-apply-gate');
const { TRUSTED_RECOUPMENT_HOSTS } = require('../../scripts/lib/trusted-recoupment-domains');

const SCRAPER = 'recoupment-announcement-scraper';

describe('commercial-apply-gate', () => {
  describe('meetsConfidenceThreshold', () => {
    it('passes when minConfidence is all/null/undefined', () => {
      const entry = { confidence: 'low' };
      assert.equal(gate.meetsConfidenceThreshold(entry, 'all'), true);
      assert.equal(gate.meetsConfidenceThreshold(entry, null), true);
      assert.equal(gate.meetsConfidenceThreshold(entry, undefined), true);
    });
    it('rejects entries below threshold', () => {
      assert.equal(gate.meetsConfidenceThreshold({ confidence: 'low' }, 'high'), false);
      assert.equal(gate.meetsConfidenceThreshold({ confidence: 'medium' }, 'high'), false);
      assert.equal(gate.meetsConfidenceThreshold({ confidence: 'high' }, 'high'), true);
    });
    it('treats missing confidence as zero', () => {
      assert.equal(gate.meetsConfidenceThreshold({}, 'low'), false);
    });
  });

  describe('hasRecoupedClaim', () => {
    it('detects entry.recouped === true', () => {
      assert.equal(gate.hasRecoupedClaim({ recouped: true }), true);
    });
    it('detects entry._recoupedClaim === true', () => {
      assert.equal(gate.hasRecoupedClaim({ _recoupedClaim: true }), true);
    });
    it('returns false otherwise', () => {
      assert.equal(gate.hasRecoupedClaim({ recouped: false }), false);
      assert.equal(gate.hasRecoupedClaim({}), false);
    });
  });

  describe('isAutoApplyableClaim — Friday scraper hot path', () => {
    const goodEntry = {
      recouped: true,
      _recoupedClaim: true,
      detectedBy: SCRAPER,
      confidence: 'high',
      sourceHost: 'nytimes.com',
      sourceUrl: 'https://www.nytimes.com/2026/05/19/theater/giant.html',
    };

    it('passes the canonical Giant-style scraper finding', () => {
      assert.equal(gate.isAutoApplyableClaim(goodEntry, [SCRAPER]), true);
    });

    it('rejects when --auto-apply-claims-from is empty', () => {
      assert.equal(gate.isAutoApplyableClaim(goodEntry, []), false);
      assert.equal(gate.isAutoApplyableClaim(goodEntry, null), false);
      assert.equal(gate.isAutoApplyableClaim(goodEntry, undefined), false);
    });

    it('rejects when detectedBy is unknown', () => {
      assert.equal(gate.isAutoApplyableClaim(
        { ...goodEntry, detectedBy: 'some-other-script' }, [SCRAPER]
      ), false);
    });

    it('rejects when confidence < high', () => {
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, confidence: 'medium' }, [SCRAPER]), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, confidence: 'low' }, [SCRAPER]), false);
    });

    it('rejects when sourceHost is not in trusted whitelist', () => {
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: 'random-blog.com' }, [SCRAPER]), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: '' }, [SCRAPER]), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: undefined }, [SCRAPER]), false);
    });

    it('rejects when sourceHost is missing entirely (cant trust prose-only recoupedSource)', () => {
      // Many existing writers (backfill-commercial-o4mini.js) put PROSE in
      // entry.recoupedSource ("Reddit post-mortem: did not come close..."). The
      // gate must check sourceHost specifically, not recoupedSource.
      const proseEntry = {
        recouped: true,
        _recoupedClaim: true,
        detectedBy: SCRAPER,
        confidence: 'high',
        recoupedSource: 'Reddit post-mortem: did not come close to recouping',
        // no sourceHost
      };
      assert.equal(gate.isAutoApplyableClaim(proseEntry, [SCRAPER]), false);
    });

    it('accepts every host in TRUSTED_RECOUPMENT_HOSTS', () => {
      for (const host of TRUSTED_RECOUPMENT_HOSTS) {
        assert.equal(
          gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: host }, [SCRAPER]),
          true,
          `trusted host ${host} should pass`
        );
      }
    });
  });
});
