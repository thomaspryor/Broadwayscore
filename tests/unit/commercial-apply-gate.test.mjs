// Unit tests for the apply-commercial-pending decision gate.
// Per feedback_test_extraction_pattern.md — tests the real module via require(),
// not a re-implemented copy.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
      assert.equal(result.designation, 'TBD'); // never written with no label (BRO-5824)
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
      assert.equal(result.designation, 'TBD', 'string "undefined" designation must be dropped (TBD, never no label: BRO-5824)');
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
      // An estimate on the record keeps the size (a bare "flop" is Did Not Recoup, BRO-5636).
      const result = gate.buildCommercialEntry({ designation: 'flop', recouped: false }, { designation: 'TBD', estimatedRecoupmentPct: [0, 10] }, { mergeExisting: true });
      assert.equal(result.designation, 'Flop');
      assert.equal(gate.buildCommercialEntry({ designation: 'did-not-recoup', recouped: false }, null, {}).designation, 'Did Not Recoup');
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

    it('policy B: a hand-set loss resting on "no recoupment announced" flips on recoupment news (BRO-5020)', () => {
      const silence = {
        designation: 'Flop', recouped: false, notes: 'closed after 3 months',
        designationBasis: 'no-recoupment-announced', needsLossEvidence: true,
      };
      assert.equal(gate.recoupClaimDesignationAction(silence), 'reset');
      assert.equal(gate.recoupClaimDesignationAction({ ...silence, designationBasis: 'reported-loss' }), 'block', 'a reported loss is a human call');
      assert.equal(gate.recoupClaimDesignationAction({ ...silence, designationBasis: 'notes-stated' }), 'block');
      assert.equal(gate.recoupClaimDesignationAction({ ...silence, humanReviewedDesignation: true }), 'block', 'a lock still wins');
      const result = gate.buildCommercialEntry(claim, silence, { isClaimAutoApply: true });
      assert.equal(result.designation, 'TBD');
      assert.equal(result.recouped, true);
      assert.equal(result.recoupedSource, claim.recoupedSource);
      assert.equal('designationBasis' in result, false, 'the silence basis is cleared');
      assert.equal('needsLossEvidence' in result, false);
    });

    it('the reset of an inferred Fizzle also clears its basis stamp', () => {
      const result = gate.buildCommercialEntry(claim, { ...PURPOSE_EXISTING, designationBasis: 'no-recoupment-announced' }, { isClaimAutoApply: true });
      assert.equal(result.designation, 'TBD');
      assert.equal('designationBasis' in result, false);
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

describe('designationBasis on every loss label (BRO-5020 policy B)', () => {
  const checks = require('../../scripts/lib/commercial-record-checks');
  it('a researched Fizzle with no basis gets the cautious silence basis', () => {
    const r = gate.buildCommercialEntry({ designation: 'Fizzle', recouped: false }, { designation: 'TBD', needsLossEvidence: true });
    assert.equal(r.designationBasis, 'no-recoupment-announced');
    assert.equal(r.needsLossEvidence, undefined);
  });
  it('keeps a valid basis from the entry, else from an unchanged existing label', () => {
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop', designationBasis: 'reported-loss' }, null).designationBasis, 'reported-loss');
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop', designationBasis: 'bogus' }, null).designationBasis, 'no-recoupment-announced');
    const sized = { estimatedRecoupmentPct: [0, 10] }; // a Flop needs an estimate behind it (BRO-5636)
    const merge = { mergeExisting: true };
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop' }, { ...sized, designation: 'Flop', designationBasis: 'reported-loss' }, merge).designationBasis, 'reported-loss');
    // A changed label does not inherit the old row's basis.
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop' }, { ...sized, designation: 'Fizzle', designationBasis: 'reported-loss' }, merge).designationBasis, 'no-recoupment-announced');
  });
  it('a non-loss label drops the basis; a settled label drops the evidence flag, TBD keeps it', () => {
    const win = gate.buildCommercialEntry({ designation: 'Windfall', recouped: true }, { designation: 'Fizzle', designationBasis: 'reported-loss', needsLossEvidence: true }, { isClaimAutoApply: true });
    assert.equal(win.designationBasis, undefined);
    assert.equal(win.needsLossEvidence, undefined);
    const tbd = gate.buildCommercialEntry({ notes: 'x' }, { designation: 'TBD', needsLossEvidence: true }, { isClaimAutoApply: true });
    assert.equal(tbd.needsLossEvidence, true);
  });
  it('Did Not Recoup is a loss label: it keeps or gets a basis and settles the evidence flag (BRO-5636)', () => {
    const r = gate.buildCommercialEntry({ designation: 'Did Not Recoup', recouped: false }, { designation: 'TBD', needsLossEvidence: true });
    assert.equal(r.designationBasis, 'no-recoupment-announced');
    assert.equal(r.needsLossEvidence, undefined);
    assert.equal(gate.buildCommercialEntry({ designation: 'Did Not Recoup' }, { designation: 'Did Not Recoup', designationBasis: 'reported-loss' }).designationBasis, 'reported-loss');
    const row = { designation: 'Did Not Recoup', designationBasis: 'reported-loss' };
    gate.stampDesignationBasis(row, { designationBasis: row.designationBasis }, null); // the data-plan field edit
    assert.equal(row.designationBasis, 'reported-loss');
  });
  it('research names a loss; the record being written sizes it (BRO-5636)', () => {
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop', recouped: false }, null).designation, 'Did Not Recoup');
    const existing = { designation: 'TBD', modelDataQuality: 'high', modelReturnedExCreditPct: [10, 20, 30] };
    assert.equal(gate.buildCommercialEntry({ designation: 'Did Not Recoup', recouped: false }, existing, { mergeExisting: true }).designation, 'Flop');
    // A from-scratch write keeps none of the old figures, so it claims no size.
    assert.equal(gate.buildCommercialEntry({ designation: 'Fizzle', recouped: false }, { designation: 'TBD', analystRecoupPct: [10, 20] }).designation, 'Did Not Recoup');
    // A label a person locked, or an owner-approved row, keeps its size.
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop', recouped: false }, { designation: 'Flop', humanReviewedDesignation: true }).designation, 'Flop');
    assert.equal(gate.buildCommercialEntry({ designation: 'Flop', recouped: false, ownerApproved: true }, null).designation, 'Flop');
    assert.equal(gate.buildCommercialEntry({ designation: 'Windfall', recouped: true }, null).designation, 'Windfall');
  });
  it('recoupment news resets a silence-basis Did Not Recoup and leaves a reported or locked one to a person', () => {
    const silence = { designation: 'Did Not Recoup', recouped: false, designationBasis: 'no-recoupment-announced' };
    assert.equal(gate.recoupClaimDesignationAction(silence), 'reset');
    assert.equal(gate.recoupClaimDesignationAction({ ...silence, designationBasis: 'reported-loss' }), 'block');
    assert.equal(gate.recoupClaimDesignationAction({ ...silence, humanReviewedDesignation: true }), 'block');
  });
  it('the public-record sanitizer drops the basis when it un-labels a running show', () => {
    const { entry } = checks.sanitizeForPublicRecord({ designation: 'Fizzle', designationBasis: 'no-recoupment-announced' }, { status: 'open' });
    assert.equal(entry.designation, 'TBD');
    assert.equal(entry.designationBasis, undefined);
  });
});

describe('held-row release (BRO-5041)', () => {
  it('refuses records a person or a verified pass already settled', () => {
    assert.equal(gate.heldReleaseRefusal(undefined), null);
    assert.equal(gate.heldReleaseRefusal({ designation: 'TBD' }), null);
    assert.equal(gate.heldReleaseRefusal({ designation: 'tbd', recouped: false }), null);
    assert.match(gate.heldReleaseRefusal({ designation: 'TBD', humanReviewedDesignation: true }), /human review/);
    assert.match(gate.heldReleaseRefusal({ designation: 'Windfall' }), /Windfall/);
    assert.match(gate.heldReleaseRefusal({ designation: 'TBD', recouped: true }), /recoupment/);
    assert.match(gate.heldReleaseRefusal({ designation: 'TBD', humanReviewedRecouped: true }), /recoupment/);
  });
  it('refuses a row whose own label says it recouped (the release drops that claim)', () => {
    assert.match(gate.heldReleaseRefusal(undefined, { designation: 'Windfall', recouped: true }), /Windfall/);
    assert.match(gate.heldReleaseRefusal({ designation: 'TBD' }, { designation: 'easy winner' }), /Easy Winner/);
    assert.equal(gate.heldReleaseRefusal({ designation: 'TBD' }, { designation: 'Flop', recouped: false }), null);
  });
  it('refuses a row the truth review did not release, unless the owner approved it', () => {
    const held = { designation: 'Flop', recouped: false, truthReview: { verdict: 'held' } };
    assert.match(gate.heldReleaseRefusal(undefined, held), /truth review verdict is "held"/);
    assert.match(gate.heldReleaseRefusal({ designation: 'TBD' }, { designation: 'TBD', truthReview: { verdict: 'cap-released' } }), /cap-released/);
    assert.match(gate.heldReleaseRefusal(undefined, { truthReview: { verdict: 'rejected' } }), /rejected/);
    assert.equal(gate.heldReleaseRefusal(undefined, { designation: 'TBD', truthReview: { verdict: 'released' } }), null);
    assert.equal(gate.heldReleaseRefusal(undefined, { ...held, ownerApproved: true }), null);
    assert.equal(gate.heldReleaseRefusal(undefined, { designation: 'TBD' }), null, 'no truth review stamp: unchanged');
  });
  it('drops the research "_recoupedClaim" flag so the claim gate does not hold the row', () => {
    const out = gate.withoutRecoupmentClaim({ designation: 'Flop', recouped: false, _recoupedClaim: true });
    assert.deepEqual(out, { designation: 'Flop', recouped: false });
    assert.equal(gate.hasRecoupedClaim(out), false);
  });
  it('drops a "recouped" claim and nothing else; a cited loss stays', () => {
    const row = { designation: 'Easy Winner', capitalization: 5e6, recouped: true, recoupedDate: null, recoupedSource: 'forum thread', requiresHumanReview: true };
    const out = gate.withoutRecoupmentClaim(row);
    assert.deepEqual(out, { designation: 'Easy Winner', capitalization: 5e6, requiresHumanReview: true });
    assert.equal(row.recouped, true, 'input not mutated');
    const loss = { designation: 'Flop', recouped: false, recoupedSource: 'Broadway Journal: closed at a loss' };
    assert.deepEqual(gate.withoutRecoupmentClaim(loss), loss);
  });
  it('mergeExisting keeps the record fields the row does not carry and merges sources', () => {
    const existing = { designation: 'TBD', capitalization: 4e6, capitalizationSource: 'SEC filing', modelRecouped: false, estimatedRecoupmentPct: [0, 10], sources: [{ url: 'https://a.example/1' }] };
    const row = { designation: 'Flop', sources: [{ url: 'https://b.example/2' }, { url: 'https://a.example/1' }] };
    const merged = gate.buildCommercialEntry(row, existing, { mergeExisting: true });
    assert.equal(merged.designation, 'Flop');
    assert.equal(merged.capitalization, 4e6);
    assert.equal(merged.capitalizationSource, 'SEC filing', 'a figure the row does not touch keeps its citation');
    const refigured = gate.buildCommercialEntry({ ...row, capitalization: 9e6 }, existing, { mergeExisting: true });
    assert.equal(refigured.capitalizationSource, undefined, 'a new unverified figure never inherits the old citation');
    assert.equal(refigured.isEstimate.capitalization, true);
    assert.equal(merged.modelRecouped, false);
    assert.deepEqual(merged.sources.map(s => s.url), ['https://a.example/1', 'https://b.example/2']);
    const rebuilt = gate.buildCommercialEntry(row, existing, {});
    assert.equal(rebuilt.modelRecouped, undefined, 'default path still rebuilds from scratch');
  });
  it('BRO-5639: research apply onto a TBD record keeps costHistory and analyst fields', () => {
    const existing = {
      designation: 'TBD', capitalization: 4e6, capitalizationSource: 'SEC filing',
      costHistory: [{ date: '2025-01-01', capitalization: 4e6 }],
      analystRecoupPct: 55, analystSources: [{ url: 'https://analyst.example/1' }],
      estimatedRecoupmentPct: [20, 40], sources: [{ url: 'https://a.example/1' }],
    };
    const row = { designation: 'Flop', recouped: false, sources: [{ url: 'https://b.example/2' }] };
    const out = gate.buildCommercialEntry(row, existing, { mergeExisting: true });
    assert.deepEqual(out.costHistory, existing.costHistory);
    assert.equal(out.analystRecoupPct, 55);
    assert.deepEqual(out.analystSources, existing.analystSources);
    assert.deepEqual(out.estimatedRecoupmentPct, [20, 40]);
    assert.equal(out.designation, 'Fizzle', 'loss sizing sees the kept estimate');
    const dropped = gate.buildCommercialEntry(row, existing, {});
    assert.equal(dropped.costHistory, undefined, 'from-scratch rebuild is what the caller must not use for existing records');
  });
  it('BRO-5639: recouped:false research drops the old record\'s recoupment evidence', () => {
    const existing = { designation: 'TBD', recouped: true, recoupedDate: '2025-12', recoupedSource: 'x', humanReviewedRecouped: true };
    const out = gate.buildCommercialEntry({ designation: 'Flop', recouped: false }, existing, { mergeExisting: true });
    assert.equal(out.recouped, false);
    assert.equal(out.recoupedDate, undefined);
    assert.equal(out.recoupedSource, undefined);
    assert.equal(out.humanReviewedRecouped, undefined);
  });
  it('BRO-5639: a research label clears a stale classify-stale-closures attribution', () => {
    const existing = { designation: 'Fizzle', classifiedBy: 'classify-stale-closures', classifiedAt: '2026-01-01', classifiedReason: 'closed, no recoupment found' };
    const out = gate.buildCommercialEntry({ designation: 'Flop', recouped: false }, existing, { mergeExisting: true });
    assert.equal(out.classifiedBy, undefined);
    assert.equal(out.classifiedReason, undefined);
    const kept = gate.buildCommercialEntry({ recouped: false }, existing, { mergeExisting: true });
    assert.equal(kept.classifiedBy, 'classify-stale-closures', 'no new label, no clearing');
  });
  it('BRO-5639: apply-commercial-pending passes mergeExisting for every existing record', () => {
    const src = fs.readFileSync(path.resolve('scripts/apply-commercial-pending.js'), 'utf8');
    assert.match(src, /const mergeExisting = Boolean\(RELEASE_HELD \|\| \(existing && !SINGLE_SHOW\)\)/);
  });
  it('CLI: --release-held applies only eligible held rows; plain --show and --all leave held rows pending', () => {
    const dir = fs.mkdtempSync(path.resolve('tests/.bro5041-'));
    try {
      const held = (designation, recouped = false) => ({ designation, confidence: 'medium', requiresHumanReview: true, backfill: 'BRO-4990', recouped, recoupedSource: 'https://news.example/closing', sources: [] });
      fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ shows: {
        fresh: held('Flop'), labelled: held('Fizzle'), tbd: held('Fizzle'), claimed: held('Flop', true),
        unheld: { designation: 'Flop', confidence: 'high', recouped: false, recoupedSource: 'https://news.example/closing', sources: [] },
      } }));
      fs.writeFileSync(path.join(dir, 'commercial.json'), JSON.stringify({ shows: {
        labelled: { designation: 'Windfall' }, tbd: { designation: 'TBD', modelRecouped: false },
      } }));
      const mk = (slug) => ({ id: `${slug}-2020`, slug, title: slug, category: 'broadway', status: 'closed' });
      fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: ['fresh', 'labelled', 'tbd', 'claimed', 'unheld'].map(mk) }));
      const base = ['scripts/apply-commercial-pending.js', '--dry-run', `--pending-file=${dir}/pending.json`, `--commercial-file=${dir}/commercial.json`, `--shows-file=${dir}/shows.json`];
      const out = execFileSync(process.execPath, [...base, '--release-held=fresh,labelled,tbd,claimed,unheld,gone'], { encoding: 'utf8' });
      assert.match(out, /Not in pending file[^\n]*gone/);
      assert.match(out, /"labelled" — not released: record already has designation "Windfall"/);
      assert.match(out, /"unheld" — not a held row/);
      assert.match(out, /Would apply "tbd" → [^\n]*"modelRecouped":false/);
      assert.doesNotMatch(out, /"recouped":true/);
      // The release drops "claimed"'s recouped:true, which leaves a Flop with no
      // recouped:false: the per-row check keeps it pending.
      assert.match(out, /"claimed" — left pending for review: [^\n]*loss-designations require recouped=false/);
      assert.match(out, /would apply 2, skip 3/);
      const single = execFileSync(process.execPath, [...base, '--show=fresh'], { encoding: 'utf8' });
      assert.match(single, /needs human review \(release with --release-held=fresh\)/);
      const all = execFileSync(process.execPath, [...base, '--all'], { encoding: 'utf8' });
      assert.match(all, /would apply 1, skip 4/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
  });
});

describe('first-person research notes never reach /biz (BRO-5041)', () => {
  const checks = require('../../scripts/lib/commercial-record-checks.js');
  it('flags a researcher describing the search', () => {
    assert.ok(checks.internalWordingIn("I couldn't verify a production-specific weekly nut."));
    assert.ok(checks.internalWordingIn('We found no recoupment report in the trades.'));
    assert.equal(checks.internalWordingIn('Act I could not have been staged more cheaply, critics said.'), null);
    assert.equal(checks.internalWordingIn('Closed after 12 weeks; capitalized at $14.5M.'), null);
    assert.ok(checks.internalWordingIn('Reports vary; I used the $17M AP figure.'));
    assert.ok(checks.internalWordingIn('No weekly nut surfaced, so that field is null.'));
    assert.ok(checks.internalWordingIn('Best-fit designation is Fizzle.'));
    assert.ok(checks.internalWordingIn('Closed early. ([ibdb.com](https://www.ibdb.com/x?utm_source=openai))'));
    assert.equal(checks.internalWordingIn("Transferred from MTC's 2022 off-Broadway Stage I run."), null);
    assert.equal(checks.internalWordingIn('"I lost everything," the lead producer told the Times.'), null);
    for (const prose of ['Aimed at World War I veterans.', 'Funded with Title I money.', 'A play about Mary I of England.', "Rajiv Joseph's I and You transferred."]) {
      assert.equal(checks.internalWordingIn(prose), null, prose);
    }
    assert.equal(checks.internalWordingIn('The producer said “we could not keep the lights on.”'), null);
    assert.equal(checks.internalWordingIn('Source: https://example.com/a-(b)'), null);
  });
  it('sanitize removes markdown citation links and leaves the sentence', () => {
    const out = checks.sanitizeForPublicRecord({ notes: 'Ran at Studio 54. Not-for-profit producer. ([ibdb.com](https://www.ibdb.com/x?utm_source=openai))' }, { status: 'closed' });
    assert.equal(out.entry.notes, 'Ran at Studio 54. Not-for-profit producer.');
    const only = checks.sanitizeForPublicRecord({ notes: '([playbill.com](https://playbill.com/a?utm_source=openai))' }, { status: 'closed' });
    assert.equal(only.entry.notes, null);
  });
  it('sanitize drops only the first-person sentence', () => {
    const out = checks.sanitizeForPublicRecord({ notes: "Capitalized at $14.5M. I couldn't verify the weekly nut." }, { status: 'closed' });
    assert.equal(out.entry.notes, 'Capitalized at $14.5M.');
  });
});

describe('released rows keep the record\'s own text (BRO-5041 review)', () => {
  const checks = require('../../scripts/lib/commercial-record-checks.js');
  it('a markdown citation in a source field becomes the bare URL', () => {
    const out = checks.sanitizeForPublicRecord({ recouped: false, recoupedSource: '([variety.com](https://variety.com/a/?utm_source=openai))' }, { status: 'closed' });
    assert.equal(out.entry.recoupedSource, 'https://variety.com/a/');
    const kept = checks.sanitizeForPublicRecord({ capitalizationSource: 'SEC Form D [sec.gov](https://sec.gov/x?id=1&utm_source=openai)' }, { status: 'closed' });
    assert.equal(kept.entry.capitalizationSource, 'SEC Form D https://sec.gov/x?id=1');
  });
  it('keepExistingPublicText keeps notes and an unchanged recoupment citation', () => {
    const entry = { notes: null, recouped: false, recoupedSource: 'https://row.example/' };
    gate.keepExistingPublicText(entry, { notes: 'Capitalized at $5,976,500 per SEC Form D/A.', recouped: false, recoupedSource: 'https://record.example/' });
    assert.equal(entry.notes, 'Capitalized at $5,976,500 per SEC Form D/A.');
    assert.equal(entry.recoupedSource, 'https://record.example/');
    const fresh = { notes: 'Row note.', recouped: false, recoupedSource: 'https://row.example/' };
    gate.keepExistingPublicText(fresh, { notes: '  ', recoupedSource: 'https://old.example/' });
    assert.deepEqual(fresh, { notes: 'Row note.', recouped: false, recoupedSource: 'https://row.example/' });
  });
});

// BRO-5264 retro-review (BRO-5261): automated writers drop a placeholder link
// they would add, and keep one already on the record.
describe('buildCommercialEntry placeholder sources', () => {
  const { normalizeSources } = require('../../scripts/lib/commercial-sources');
  it('drops new homepage / Wikipedia / own-site links, keeps articles and existing links', () => {
    const existing = { designation: 'TBD', sources: [{ type: 'trade', url: 'https://en.wikipedia.org/wiki/Old', date: null }] };
    const entry = { designation: 'TBD', sources: [
      { type: 'trade', url: 'https://www.broadwayjournal.com', date: '2026-10-01' },
      { type: 'trade', url: 'https://en.wikipedia.org/wiki/New', date: '2026-10-01' },
      { type: 'trade', url: 'https://broadwayscorecard.com/show/x', date: '2026-10-01' },
      { type: 'trade', url: 'https://www.broadwayjournal.com/p/hells-kitchen-recoupment', date: '2026-10-01' },
      { type: 'trade', url: 'https://en.wikipedia.org/wiki/Old', date: null },
    ] };
    const out = gate.buildCommercialEntry(entry, existing, { isClaimAutoApply: true, normalizeSources });
    assert.deepEqual(out.sources.map((s) => s.url), ['https://en.wikipedia.org/wiki/Old', 'https://www.broadwayjournal.com/p/hells-kitchen-recoupment']);
    const fresh = gate.buildCommercialEntry(entry, existing, { normalizeSources });
    assert.deepEqual(fresh.sources.map((s) => s.url), ['https://www.broadwayjournal.com/p/hells-kitchen-recoupment', 'https://en.wikipedia.org/wiki/Old']);
  });
});

describe('buildCommercialEntry placeholder sources (ship-check)', () => {
  const { normalizeSources } = require('../../scripts/lib/commercial-sources');
  it('a rebuild whose new links are all placeholders keeps the record\'s sources', () => {
    const existing = { designation: 'TBD', sources: [{ type: 'trade', url: 'https://deadline.com/2026/01/x/', date: null }] };
    const out = gate.buildCommercialEntry({ designation: 'TBD', sources: [{ type: 'trade', url: 'https://playbill.com', date: null }] }, existing, { normalizeSources });
    assert.deepEqual(out.sources.map((s) => s.url), ['https://deadline.com/2026/01/x/']);
  });
  it('a second entry reusing an old placeholder link is dropped, like the record check warns', () => {
    const existing = { designation: 'TBD', sources: [{ type: 'trade', url: 'https://www.amny.com', date: null }] };
    const entry = { designation: 'TBD', sources: [
      { type: 'trade', url: 'https://www.amny.com', date: null },
      { type: 'trade', url: 'https://www.amny.com', date: '2026-10-12', excerpt: 'investors got back 55%' },
    ] };
    const out = gate.buildCommercialEntry(entry, existing, { normalizeSources });
    assert.equal(out.sources.length, 1);
  });
});

// BRO-5660: capitalizationBasis tracks the figure the apply gate writes.
describe('capitalizationBasis on apply', () => {
  const { retagCapitalizationBasis } = require('../../scripts/lib/public-source-text');
  const ev = (quote) => ({ capitalization: { found: true, quote, source: { url: 'https://www.sec.gov/x' } } });

  it('a verified "up to" quote tags a maximum, a fully sold one tags sold', () => {
    const max = gate.buildCommercialEntry({ designation: 'TBD', capitalization: 18000000 }, null, { figureEvidence: ev('an offering of up to $18,000,000') });
    assert.equal(max.capitalizationBasis, 'maximum');
    const sold = gate.buildCommercialEntry({ designation: 'TBD', capitalization: 15000000 }, null, { figureEvidence: ev('$15M, fully sold') });
    assert.equal(sold.capitalizationBasis, 'sold');
  });

  it('a restated unchanged figure keeps the explicit basis its wording does not show', () => {
    const existing = { designation: 'TBD', capitalization: 9000000, capitalizationBasis: 'maximum', capitalizationSource: 'SEC Form D (Othello LLC)' };
    const r = gate.buildCommercialEntry({ designation: 'TBD', capitalization: 9000000 }, existing, { isClaimAutoApply: true });
    assert.equal(r.capitalizationBasis, 'maximum');
  });

  it('a changed figure under wording that says neither drops the old basis', () => {
    const existing = { designation: 'TBD', capitalization: 9000000, capitalizationBasis: 'maximum', capitalizationSource: 'SEC Form D (Othello LLC)' };
    const r = gate.buildCommercialEntry({ designation: 'TBD', capitalization: 7000000 }, existing, { isClaimAutoApply: true });
    assert.equal(r.capitalizationBasis, undefined);
  });

  it('retagCapitalizationBasis sets from wording and clears when wording says neither', () => {
    const a = { capitalization: 1, capitalizationSource: 'Variety: up to $5M', capitalizationBasis: 'sold' };
    retagCapitalizationBasis(a);
    assert.equal(a.capitalizationBasis, 'maximum');
    const b = { capitalization: 1, capitalizationSource: 'Variety', capitalizationBasis: 'sold' };
    retagCapitalizationBasis(b);
    assert.equal('capitalizationBasis' in b, false);
  });
});

it('"not fully sold" is not a sold basis (BRO-5660)', () => {
  const { capitalizationBasisFromText } = require('../../scripts/lib/public-source-text');
  assert.equal(capitalizationBasisFromText('SEC Form D: up to $10M, not fully sold'), 'maximum');
  assert.equal(capitalizationBasisFromText('SEC Form D/A: $10M, fully sold'), 'sold');
});

it('a filing\'s "Offering capitalized at" is a sold basis, its limits are not (BRO-5647)', () => {
  const { capitalizationBasisFromText } = require('../../scripts/lib/public-source-text');
  assert.equal(capitalizationBasisFromText('SEC Form D/A (Cottage Play Ltd Liability Co): "Maximum capitalization was $6,000,000/Minimum capitalization was $4,000,000 - Offering capitalized at $4,108,500"'), 'sold');
  assert.equal(capitalizationBasisFromText('SEC Form D: "Entity capitalized at $10,000,000"'), 'sold');
  assert.equal(capitalizationBasisFromText('SEC Form D: "Maximum offering capitalized at $8,000,000"'), 'maximum');
  assert.notEqual(capitalizationBasisFromText('Max offering capitalized at $6M'), 'sold');
  assert.notEqual(capitalizationBasisFromText('Maximum total offering capitalized at $6,000,000'), 'sold');
  assert.notEqual(capitalizationBasisFromText('Max-offering capitalized at $6,000,000'), 'sold');
  assert.equal(capitalizationBasisFromText('offering was capitalized at $6M (max cap)'), 'maximum');
  assert.notEqual(capitalizationBasisFromText('offering capitalized at $6,000,000 maximum'), 'sold');
  assert.equal(capitalizationBasisFromText('offering capitalized at $6 million, fully subscribed'), 'sold');
  assert.equal(capitalizationBasisFromText('Offering capitalized at $4,108,500. Maximum capitalization was $6,000,000'), 'sold');
  assert.equal(capitalizationBasisFromText('Offering capitalized at $4,108,500 Maximum capitalization was $6,000,000'), 'sold');
  assert.equal(capitalizationBasisFromText('Broadway Journal: "Its capitalization is indeed modest for Broadway ... a maximum of $9.5 million"'), 'maximum');
});

// BRO-5815: a source that names an outlet but quotes nothing cannot be written.
describe('bare capitalizationSource (BRO-5815)', () => {
  const { isBareCapitalizationSource } = require('../../scripts/lib/public-source-text');
  const { applyCommercialFieldEdit } = require('../../scripts/lib/commercial-field-edit');

  it('flags an outlet name, passes quotes, URLs and basis wording', () => {
    for (const s of ['Broadway Journal (Philip Boroff)', 'SEC filing / press reports', 'Deadline (Feb 2025)']) assert.equal(isBareCapitalizationSource(s), true, s);
    for (const s of ['Broadway Journal: "a maximum of $9.5 million"', 'https://www.sec.gov/Archives/edgar/data/1/x', 'SEC Form D: up to $10M', 'SEC Form D/A: $10M, fully sold', 'Estimate: about 2.6 times its NY tax credit', 'Not disclosed by Disney.', '', null]) assert.equal(isBareCapitalizationSource(s), false, String(s));
  });

  it('applyCommercialFieldEdit refuses a bare new source and accepts a quoted one', () => {
    const mk = () => ({ shows: { x: { capitalization: 9500000, capitalizationSource: null } } });
    const bad = applyCommercialFieldEdit(mk(), 'x', 'capitalizationSource', null, 'Broadway Journal (Philip Boroff)');
    assert.equal(bad.ok, false);
    const c = mk();
    const good = applyCommercialFieldEdit(c, 'x', 'capitalizationSource', null, 'Broadway Journal: "a maximum of $9.5 million"');
    assert.equal(good.ok, true);
    assert.equal(c.shows.x.capitalizationBasis, 'maximum');
  });

  it('applyCommercialFieldEdit writes a valid costHistory and refuses a malformed anchor (BRO-6218)', () => {
    const old = [{ asOf: '2025-09-07', amount: 1500000, kind: 'running-cost', sourceType: 'trade', sourceUrl: 'https://example.com/a', note: 'n' }];
    const mk = () => ({ shows: { x: { costHistory: old } } });
    const redated = [{ ...old[0], asOf: '2024-05-15', periodStart: '2024-04-21', periodEnd: '2024-06-08', reportedAt: '2025-09-25', dateBasis: 'period-midpoint' }];
    const c = mk();
    assert.equal(applyCommercialFieldEdit(c, 'x', 'costHistory', old, redated).ok, true);
    assert.equal(c.shows.x.costHistory[0].asOf, '2024-05-15');
    const noUrl = applyCommercialFieldEdit(mk(), 'x', 'costHistory', old, [{ ...redated[0], sourceUrl: null }]);
    assert.equal(noUrl.ok, false);
    assert.match(noUrl.reason, /costHistory\[0\].*sourceUrl/);
    assert.equal(applyCommercialFieldEdit(mk(), 'x', 'costHistory', old, { asOf: '2024-05-15' }).ok, false);
    const outside = applyCommercialFieldEdit(mk(), 'x', 'costHistory', old, [{ ...redated[0], asOf: '2024-07-01' }]);
    assert.match(outside.reason, /asOf is after periodEnd/);
    const early = applyCommercialFieldEdit(mk(), 'x', 'costHistory', old, [{ ...redated[0], reportedAt: '2024-05-01' }]);
    assert.match(early.reason, /later than reportedAt/);
    // Compare-and-set on the whole array: a plan built on a stale copy is refused.
    const stale = applyCommercialFieldEdit(mk(), 'x', 'costHistory', [{ ...old[0], amount: 1 }], redated);
    assert.equal(stale.ok, false);
  });
});

describe('buildCommercialEntry: a brand-new record always has a designation (BRO-5824)', () => {
  it('a recoupment claim for a show with no record writes TBD, not no label', () => {
    const claim = { recouped: true, recoupedDate: '2018-03', recoupedSource: 'https://playbill.com/article/x', sources: [{ type: 'trade', url: 'https://playbill.com/article/x', date: '2018-03-26' }] };
    assert.equal(gate.buildCommercialEntry(claim, undefined, { isClaimAutoApply: true }).designation, 'TBD');
    assert.equal(gate.buildCommercialEntry(claim, undefined, {}).designation, 'TBD');
  });
  it('keeps a canonical label from the entry or the existing record', () => {
    assert.equal(gate.buildCommercialEntry({ designation: 'Nonprofit' }, undefined, {}).designation, 'Nonprofit');
    assert.equal(gate.buildCommercialEntry({ recouped: true }, { designation: 'Windfall', recouped: true, recoupedDate: '2020-01' }, { isClaimAutoApply: true }).designation, 'Windfall');
  });
});

describe('model-estimate designations give way to a verified recoupment (BRO-6158)', () => {
  const est = (designation) => ({ designation, recouped: null, designationBasis: 'model-estimate' });
  it('resets an estimate on loss and recouped-side tiers, but not a locked one', () => {
    for (const d of ['Flop', 'Fizzle', 'Trickle', 'Windfall']) {
      assert.equal(gate.recoupClaimDesignationAction(est(d)), 'reset', d);
    }
    assert.equal(gate.recoupClaimDesignationAction({ ...est('Windfall'), humanReviewedDesignation: true }), 'keep');
    assert.equal(gate.recoupClaimDesignationAction({ designation: 'Windfall', recouped: true }), 'keep', 'a reported Windfall is untouched');
  });
  it('stampDesignationBasis keeps the estimate basis on Trickle/Windfall and drops it once recouped is true', () => {
    const a = { designation: 'Windfall', recouped: null };
    gate.stampDesignationBasis(a, { designationBasis: 'model-estimate' }, undefined);
    assert.equal(a.designationBasis, 'model-estimate');
    const b = { designation: 'Windfall', recouped: true };
    gate.stampDesignationBasis(b, { designationBasis: 'model-estimate' }, undefined);
    assert.equal('designationBasis' in b, false);
  });
});
