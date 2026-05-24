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

  describe('buildCommercialEntry — preserves existing fields on auto-apply', () => {
    // Regression for ship-check P0: the scraper writes only recouped fields,
    // so a naive rebuild from scratch wipes designation/capitalization/notes —
    // the exact data the Friday pipeline is supposed to PRESERVE while
    // flipping recouped.
    const existing = {
      designation: 'Easy Winner',
      capitalization: 5_600_000,
      capitalizationSource: 'NYT (...): the play has now recouped...',
      weeklyRunningCost: 450_000,
      costMethodology: 'trade-reported',
      recouped: false,
      notes: 'Limited run at Music Box. Strong opening week.',
      sources: [
        { type: 'reddit', url: 'https://reddit.com/r/Broadway/post1', date: '2026-04-01' },
      ],
      lastUpdated: '2026-05-17T00:00:00.000Z',
      firstAdded: '2026-04-01T00:00:00.000Z',
    };
    const scraperEntry = {
      recouped: true,
      _recoupedClaim: true,
      recoupedDate: '2026-05',
      recoupedSource: 'NYT (2026-05-19): explicit recoupment',
      confidence: 'high',
      detectedBy: SCRAPER,
      sourceHost: 'nytimes.com',
      sources: [
        { type: 'trade', url: 'https://www.nytimes.com/2026/05/19/giant.html', date: '2026-05-19' },
      ],
    };

    it('preserves designation when only recoupment fields are in the pending entry', () => {
      const result = gate.buildCommercialEntry(scraperEntry, existing, { isClaimAutoApply: true });
      assert.equal(result.designation, 'Easy Winner', 'designation must survive merge');
      assert.equal(result.capitalization, 5_600_000, 'capitalization must survive');
      assert.equal(result.weeklyRunningCost, 450_000, 'weeklyRunningCost must survive');
      assert.ok(result.notes && result.notes.includes('Music Box'), 'notes must survive');
    });

    it('flips recouped state from the scraper finding', () => {
      const result = gate.buildCommercialEntry(scraperEntry, existing, { isClaimAutoApply: true });
      assert.equal(result.recouped, true);
      assert.equal(result.recoupedDate, '2026-05');
      assert.equal(result.recoupedSource, scraperEntry.recoupedSource);
    });

    it('merges sources by URL — keeps prior citations, appends new', () => {
      const result = gate.buildCommercialEntry(scraperEntry, existing, { isClaimAutoApply: true });
      assert.equal(result.sources.length, 2, 'should have both reddit + NYT');
      const urls = result.sources.map(s => s.url);
      assert.ok(urls.includes('https://reddit.com/r/Broadway/post1'));
      assert.ok(urls.includes('https://www.nytimes.com/2026/05/19/giant.html'));
    });

    it('does NOT add the same source twice', () => {
      const entryWithDup = { ...scraperEntry, sources: [...existing.sources] };
      const result = gate.buildCommercialEntry(entryWithDup, existing, { isClaimAutoApply: true });
      assert.equal(result.sources.length, 1, 'duplicate URL should not be added');
    });

    it('rebuilds from scratch (no merge) when NOT an auto-apply claim', () => {
      // Deep-research / batch-research / manual-tip paths must continue to
      // rebuild from scratch — the merge only applies to auto-apply claims.
      const fullEntry = {
        designation: 'Miracle',
        capitalization: 12_500_000,
        recouped: true,
        notes: 'Long-running mega-hit',
      };
      const result = gate.buildCommercialEntry(fullEntry, existing, { isClaimAutoApply: false });
      assert.equal(result.capitalizationSource, undefined, 'old field must NOT survive non-auto-apply');
      assert.equal(result.weeklyRunningCost, undefined);
      assert.equal(result.designation, 'Miracle');
      assert.equal(result.capitalization, 12_500_000);
    });

    it('handles missing existing entry gracefully', () => {
      const result = gate.buildCommercialEntry(scraperEntry, null, { isClaimAutoApply: true });
      assert.equal(result.recouped, true);
      assert.equal(result.designation, undefined);
    });
  });
});
