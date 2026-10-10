// Unit tests for the apply-commercial-pending decision gate.
// Per feedback_test_extraction_pattern.md — tests the real module via require(),
// not a re-implemented copy.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const gate = require('../../scripts/lib/commercial-apply-gate');

describe('requiresHumanReview (BRO-4990 backfill hold)', () => {
  it('holds only entries flagged by the backfill', () => {
    assert.equal(gate.requiresHumanReview({ requiresHumanReview: true, confidence: 'high' }), true);
    assert.equal(gate.requiresHumanReview({ confidence: 'high' }), false);
    assert.equal(gate.requiresHumanReview({ requiresHumanReview: 'yes' }), false);
  });
});
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

  describe('isReviewHold — holds are never appliable', () => {
    it('detects entry._reviewHold === true', () => {
      assert.equal(gate.isReviewHold({ _reviewHold: true, recouped: true }), true);
    });
    it('returns false for ordinary pending entries (incl. recouped claims)', () => {
      assert.equal(gate.isReviewHold({ recouped: true, _recoupedClaim: true }), false);
      assert.equal(gate.isReviewHold({}), false);
      assert.equal(gate.isReviewHold({ _reviewHold: false }), false);
    });
  });

  describe('isAutoApplyableClaim — Friday scraper hot path', () => {
    const goodEntry = {
      recouped: true,
      _recoupedClaim: true,
      detectedBy: SCRAPER,
      confidence: 'high',
      sourceHost: 'nytimes.com',
      recoupedDate: '2026-05',
      sourceUrl: 'https://www.nytimes.com/2026/05/19/theater/giant.html',
    };
    // The show the claim is written to (required since the BRO-4623 ship-check).
    const GIANT_SHOW = { id: 'giant-2026', slug: 'giant', category: 'broadway', openingDate: '2026-03-23' };

    it('passes the canonical Giant-style scraper finding', () => {
      assert.equal(gate.isAutoApplyableClaim(goodEntry, [SCRAPER], GIANT_SHOW), true);
    });

    it('refuses a claim whose show cannot be resolved: the production check cannot run (fail closed)', () => {
      assert.equal(gate.isAutoApplyableClaim(goodEntry, [SCRAPER], null), false);
      assert.equal(gate.isAutoApplyableClaim(goodEntry, [SCRAPER]), false);
    });

    it('rejects a claim with no recoupedDate (would write recouped=true w/o date)', () => {
      const { recoupedDate, ...noDate } = goodEntry;
      assert.equal(gate.isAutoApplyableClaim(noDate, [SCRAPER], GIANT_SHOW), false);
    });

    it('rejects the literal "null"/garbage recoupedDate string', () => {
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, recoupedDate: 'null' }, [SCRAPER], GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, recoupedDate: '' }, [SCRAPER], GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, recoupedDate: 'May 2026' }, [SCRAPER], GIANT_SHOW), false);
    });

    it('accepts a bare-year recoupedDate', () => {
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, recoupedDate: '2026' }, [SCRAPER], GIANT_SHOW), true);
    });

    it('rejects when --auto-apply-claims-from is empty', () => {
      assert.equal(gate.isAutoApplyableClaim(goodEntry, [], GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim(goodEntry, null, GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim(goodEntry, undefined, GIANT_SHOW), false);
    });

    it('rejects when detectedBy is unknown', () => {
      assert.equal(gate.isAutoApplyableClaim(
        { ...goodEntry, detectedBy: 'some-other-script' }, [SCRAPER], GIANT_SHOW
      ), false);
    });

    it('rejects when confidence < high', () => {
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, confidence: 'medium' }, [SCRAPER], GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, confidence: 'low' }, [SCRAPER], GIANT_SHOW), false);
    });

    it('rejects when sourceHost is not in trusted whitelist', () => {
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: 'random-blog.com' }, [SCRAPER], GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: '' }, [SCRAPER], GIANT_SHOW), false);
      assert.equal(gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: undefined }, [SCRAPER], GIANT_SHOW), false);
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
      assert.equal(gate.isAutoApplyableClaim(proseEntry, [SCRAPER], GIANT_SHOW), false);
    });

    it('accepts every host in TRUSTED_RECOUPMENT_HOSTS', () => {
      for (const host of TRUSTED_RECOUPMENT_HOSTS) {
        assert.equal(
          gate.isAutoApplyableClaim({ ...goodEntry, sourceHost: host }, [SCRAPER], GIANT_SHOW),
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

    it('keeps the date and source of a recoupment already on record (BRO-4657)', () => {
      // The Outsiders, 2026-10-05: "2025-12" from Broadway News became the
      // NYT story's "2026-01" on a Friday auto-apply.
      const recorded = {
        ...existing,
        recouped: true,
        recoupedDate: '2025-12',
        recoupedSource: 'Broadway News (Jan 27, 2026): recouped as of the week ending Dec 28',
      };
      const result = gate.buildCommercialEntry(scraperEntry, recorded, { isClaimAutoApply: true });
      assert.equal(result.recouped, true);
      assert.equal(result.recoupedDate, '2025-12');
      assert.equal(result.recoupedSource, recorded.recoupedSource);
      assert.ok(result.sources.some(s => s.url === 'https://www.nytimes.com/2026/05/19/giant.html'),
        'the claim still adds its article to sources');
    });

    it('keeps a human-locked recoupment even without a date', () => {
      const locked = { ...existing, recouped: true, humanReviewedRecouped: true, recoupedSource: 'Producer statement' };
      const result = gate.buildCommercialEntry(scraperEntry, locked, { isClaimAutoApply: true });
      assert.equal(result.recoupedDate, undefined);
      assert.equal(result.recoupedSource, 'Producer statement');
    });

    it('still dates an undated, unlocked recoupment from the claim', () => {
      const undated = { ...existing, recouped: true };
      const result = gate.buildCommercialEntry(scraperEntry, undated, { isClaimAutoApply: true });
      assert.equal(result.recoupedDate, '2026-05');
      assert.equal(result.recoupedSource, scraperEntry.recoupedSource);
    });

    it('a full rebuild (not auto-apply) still takes the entry\'s recoupment', () => {
      const recorded = { ...existing, recouped: true, recoupedDate: '2025-12' };
      const result = gate.buildCommercialEntry({ ...scraperEntry, recoupedDate: '2026-02' }, recorded, { isClaimAutoApply: false });
      assert.equal(result.recoupedDate, '2026-02');
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

    it('drops literal "null"/"undefined"/"" sentinel strings instead of writing them', () => {
      // The exact shape that aborted the hourly RSS poll: an LLM verdict that
      // emitted the string "null" for recoupedDate + costMethodology. These must
      // not land in commercial.json (validate-data.js rejects them).
      const dirty = {
        recouped: true,
        recoupedDate: 'null',
        costMethodology: 'null',
        designation: 'undefined',
        notes: '  ',
      };
      const result = gate.buildCommercialEntry(dirty, null, { isClaimAutoApply: false });
      assert.equal(result.recoupedDate, undefined, 'string "null" date must be dropped');
      assert.equal(result.costMethodology, undefined, 'string "null" costMethodology must be dropped');
      assert.equal(result.designation, undefined, 'string "undefined" designation must be dropped');
      assert.equal(result.notes, undefined, 'whitespace-only notes must be dropped');
    });
  });

  describe('cleanNullish', () => {
    it('collapses sentinel strings to undefined', () => {
      for (const v of [null, undefined, '', '  ', 'null', 'NULL', 'undefined', 'Undefined']) {
        assert.equal(gate.cleanNullish(v), undefined, `${JSON.stringify(v)} → undefined`);
      }
    });
    it('passes real values through (trimmed)', () => {
      assert.equal(gate.cleanNullish('2026-05'), '2026-05');
      assert.equal(gate.cleanNullish('  trade-reported  '), 'trade-reported');
      assert.equal(gate.cleanNullish(0), 0);
      assert.equal(gate.cleanNullish(false), false);
    });
  });

  describe('designation canonicalization (BRO-4570)', () => {
    it('canonicalDesignation maps case/whitespace/underscore variants', () => {
      assert.equal(gate.canonicalDesignation('flop'), 'Flop');
      assert.equal(gate.canonicalDesignation(' easy winner '), 'Easy Winner');
      assert.equal(gate.canonicalDesignation('TOUR_STOP'), 'Tour Stop');
      assert.equal(gate.canonicalDesignation('bogus'), undefined);
      assert.equal(gate.canonicalDesignation(null), undefined);
    });

    it('buildCommercialEntry writes the canonical spelling ("flop" -> "Flop")', () => {
      const result = gate.buildCommercialEntry({ designation: 'flop', recouped: false }, null, {});
      assert.equal(result.designation, 'Flop');
    });

    it('an unknown designation never overwrites the existing one on auto-apply', () => {
      const result = gate.buildCommercialEntry(
        { designation: 'bogus', recouped: true },
        { designation: 'Windfall' },
        { isClaimAutoApply: true },
      );
      assert.equal(result.designation, 'Windfall');
    });

    it('a missing/invalid designation keeps the existing one on a from-scratch rebuild', () => {
      const result = gate.buildCommercialEntry(
        { designation: 'bogus', recouped: true },
        { designation: 'Miracle', notes: 'old' },
        { isClaimAutoApply: false },
      );
      assert.equal(result.designation, 'Miracle');
      assert.equal(result.notes, undefined, 'rebuild still drops other old fields');
    });

    it('VALID_DESIGNATIONS matches the CommercialDesignation union in src/config/commercial.ts', () => {
      const src = fs.readFileSync(new URL('../../src/config/commercial.ts', import.meta.url), 'utf8');
      const union = src.match(/export type CommercialDesignation =([^;]+);/)[1];
      const fromTs = [...union.matchAll(/'([^']+)'/g)].map(m => m[1]);
      assert.deepEqual([...gate.VALID_DESIGNATIONS].sort(), fromTs.sort());
    });
  });

  // BRO-4623: claims already queued must pass the same production check the
  // classifier now applies (show fixtures copy the real shows.json fields).
  describe('isAutoApplyableClaim with the show — wrong-production claims never auto-apply', () => {
    const BEETLEJUICE_2025 = { id: 'beetlejuice-2025', slug: 'beetlejuice-2025', category: 'broadway', previewsStartDate: null, openingDate: '2025-10-08' };
    const DEATH_OF_A_SALESMAN = { id: 'death-of-a-salesman-2026', slug: 'death-of-a-salesman', category: 'broadway', previewsStartDate: '2026-03-06', openingDate: '2026-04-09' };
    const GIANT = { id: 'giant-2026', slug: 'giant', category: 'broadway', openingDate: '2026-03-23' };
    const claim = (extra) => ({ recouped: true, _recoupedClaim: true, detectedBy: SCRAPER, confidence: 'high', ...extra });

    it('beetlejuice-2025: the queued national-tour claim (2023-10, playbill national-tour URL) is refused', () => {
      const entry = claim({ sourceHost: 'playbill.com', recoupedDate: '2023-10', recoupedSource: 'https://playbill.com/article/beetlejuice-national-tour-recoups' });
      assert.equal(gate.isAutoApplyableClaim(entry, [SCRAPER]), false, 'without the show it is refused, never applied unchecked');
      assert.equal(gate.isAutoApplyableClaim(entry, [SCRAPER], BEETLEJUICE_2025), false);
    });

    it('death-of-a-salesman: a 2012 recoupment for the 2026 revival is refused', () => {
      const entry = claim({ sourceHost: 'theatermania.com', recoupedDate: '2012-05', recoupedSource: 'https://www.theatermania.com/broadway/news/broadways-death-of-a-salesman-recoups-capitalizati_56835.html/' });
      assert.equal(gate.isAutoApplyableClaim(entry, [SCRAPER], DEATH_OF_A_SALESMAN), false);
    });

    it('a real recoupment after opening still auto-applies (Giant, 2026-05)', () => {
      const entry = claim({ sourceHost: 'nytimes.com', recoupedDate: '2026-05', recoupedSource: 'https://www.nytimes.com/2026/05/19/theater/giant.html' });
      assert.equal(gate.isAutoApplyableClaim(entry, [SCRAPER], GIANT), true);
    });
  });

  // BRO-4623 item 5: classify-stale-closures labels a closed show "Fizzle" 30
  // days after closing; Purpose then recouped ~9 months after closing.
  describe('recoupClaimDesignationAction / buildCommercialEntry — inferred Fizzle vs verified recoupment', () => {
    // purpose-2025's real commercial.json fields (notes abridged).
    const PURPOSE_EXISTING = {
      designation: 'Fizzle',
      capitalization: null,
      recouped: false,
      recoupedDate: null,
      recoupedSource: 'Inferred: closed 267 days ago, no trade-press recoupment found',
      notes: 'Commercial Broadway transfer (NOT a 2ST production despite Hayes venue)',
      classifiedBy: 'classify-stale-closures',
      classifiedAt: '2026-05-25T09:24:25.084Z',
      classifiedReason: 'closed 267d ago, deep-researched, no trade-press recoupment found',
      firstAdded: '2026-05-25T09:24:25.084Z',
    };
    const claim = {
      recouped: true,
      _recoupedClaim: true,
      recoupedDate: '2026-06',
      recoupedSource: 'https://deadline.com/2026/06/purpose-broadway-recoupment-1236941347/',
      sources: [{ type: 'trade', url: 'https://deadline.com/2026/06/purpose-broadway-recoupment-1236941347/', date: '2026-06-04' }],
    };

    it('an inferred stale-closure Fizzle is reset, a human-locked one blocks, a non-loss one is kept', () => {
      assert.equal(gate.recoupClaimDesignationAction(PURPOSE_EXISTING), 'reset');
      assert.equal(gate.recoupClaimDesignationAction({ ...PURPOSE_EXISTING, humanReviewedDesignation: true }), 'block');
      assert.equal(gate.recoupClaimDesignationAction({ designation: 'Fizzle', recouped: false }), 'block', 'a Fizzle nobody inferred is a human call');
      assert.equal(gate.recoupClaimDesignationAction({ designation: 'TBD' }), 'keep');
      assert.equal(gate.recoupClaimDesignationAction(undefined), 'keep');
    });

    it('applying the recoupment over the inferred Fizzle yields a valid TBD + recouped:true entry', () => {
      const result = gate.buildCommercialEntry(claim, PURPOSE_EXISTING, { isClaimAutoApply: true });
      assert.equal(result.designation, 'TBD');
      assert.equal(result.recouped, true);
      assert.equal(result.recoupedDate, '2026-06');
      assert.equal(result.recoupedSource, claim.recoupedSource, 'the "Inferred: ..." prose is replaced by the article');
      assert.equal(result.notes, PURPOSE_EXISTING.notes, 'other existing fields survive');
      assert.equal(result.firstAdded, PURPOSE_EXISTING.firstAdded);
      assert.equal(result.classifiedBy, undefined);
      assert.equal(result.classifiedAt, undefined);
      assert.equal(result.classifiedReason, undefined);
    });

    it('a recoupment over an existing win designation keeps it', () => {
      const result = gate.buildCommercialEntry(claim, { designation: 'Windfall', recouped: false }, { isClaimAutoApply: true });
      assert.equal(result.designation, 'Windfall');
    });
  });
});

describe('backfill hold helpers (BRO-4990)', () => {
  it('holdForBackfill flags the row and counts attempts from the prior row', () => {
    const e = gate.holdForBackfill({ designation: 'Flop' }, { researchAttempts: 2 });
    assert.deepEqual([e.requiresHumanReview, e.backfill, e.researchAttempts], [true, gate.BACKFILL_TAG, 3]);
    assert.equal(gate.holdForBackfill({}, undefined).researchAttempts, 1);
    assert.equal(gate.holdForBackfill({}, { researchAttempts: 3 }, { reset: true }).researchAttempts, 1);
  });

  it('carryHumanReviewHold keeps a held row held when a writer replaces it', () => {
    const prev = { requiresHumanReview: true, backfill: 'BRO-4990', researchAttempts: 2 };
    const next = gate.carryHumanReviewHold(prev, { designation: 'Flop', confidence: 'high' });
    assert.deepEqual([next.requiresHumanReview, next.backfill, next.researchAttempts], [true, 'BRO-4990', 2]);
    assert.equal(gate.requiresHumanReview(next), true);
    // An unheld prior row adds nothing.
    assert.equal(gate.carryHumanReviewHold({ confidence: 'low' }, { designation: 'Flop' }).requiresHumanReview, undefined);
    assert.equal(gate.carryHumanReviewHold(undefined, { designation: 'Flop' }).requiresHumanReview, undefined);
  });

  it('a noData attempt record is never appliable', () => {
    assert.equal(gate.isReviewHold({ noData: true, requiresHumanReview: true }), true);
    assert.equal(gate.isReviewHold({ designation: 'Flop' }), false);
  });
});
