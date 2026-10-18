// Unit tests for scripts/lib/classify-stale-closure.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { classifyStaleClosure, undoAutoFizzleOnRunningShow, lossLabelFor, closedTbdLossAction } = require('../../scripts/lib/classify-stale-closure');
const { LOSS_LABEL_MIN_DAYS, DESIGNATION_BASES } = require('../../scripts/lib/commercial-designations');

const NOW = Date.parse('2026-05-24T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW - n * 86_400_000).toISOString();

describe('classifyStaleClosure', () => {
  it('waits during the grace period', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(10) },
      entry: { designation: 'TBD' },
      pending: null, archive: null, now: NOW,
    });
    assert.equal(r.action, 'wait');
  });

  const researched = { designation: 'TBD', researchAttempts: 1, lastResearchedAt: daysBefore(20) };

  it('flags (never labels) a researched TBD closed under ~6 months with no recoupment news (policy B)', () => {
    // Some shows recoup after closing, so silence is not yet a loss.
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: researched, pending: null, archive: null, now: NOW,
    });
    assert.equal(r.action, 'flag-needs-loss-evidence');
    assert.equal(r.designation, undefined);
    assert.equal(r.designationBasis, undefined);
  });

  it('labels a researched TBD closed 6+ months with basis no-recoupment-announced (policy B)', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(200) },
      entry: researched, pending: null, archive: null, now: NOW,
    });
    assert.equal(r.action, 'classify-fizzle');
    assert.equal(r.designation, 'Fizzle');
    assert.equal(r.designationBasis, DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED);
    assert.equal(r.confidence, 'high');
  });

  it('the 6-month guard is exact at the boundary', () => {
    const at = (d) => classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(d) }, entry: researched, now: NOW,
    }).action;
    assert.equal(LOSS_LABEL_MIN_DAYS, 183);
    assert.equal(at(LOSS_LABEL_MIN_DAYS - 1), 'flag-needs-loss-evidence');
    assert.equal(at(LOSS_LABEL_MIN_DAYS), 'classify-fizzle');
  });

  it('requireLossEvidence is the kill switch: flags even a long-closed show', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(300) },
      entry: researched, now: NOW, thresholds: { requireLossEvidence: true },
    });
    assert.equal(r.action, 'flag-needs-loss-evidence');
    assert.equal(r.designation, undefined);
  });

  it('splits Fizzle/Flop by the reported returned %, Fizzle when none is reported', () => {
    assert.equal(lossLabelFor({ estimatedRecoupmentPct: [5, 15] }), 'Flop');
    assert.equal(lossLabelFor({ estimatedRecoupmentPct: [30, 50] }), 'Fizzle');
    assert.equal(lossLabelFor({ estimatedRecoupmentPct: 20 }), 'Flop');
    assert.equal(lossLabelFor({}), 'Fizzle');
    // The analyst's range counts and wins over an outside estimate (BRO-5602:
    // beaches, cats-the-jellicle-ball and titanique carry only [0, 0]).
    assert.equal(lossLabelFor({ analystRecoupPct: [0, 0] }), 'Flop');
    assert.equal(lossLabelFor({ analystRecoupPct: [20, 40], estimatedRecoupmentPct: [0, 10] }), 'Fizzle');
    assert.deepEqual(closedTbdLossAction({ designation: 'TBD', analystRecoupPct: [0, 0] }, { status: 'closed', closingDate: '2025-01-01' }, { now: Date.parse('2026-10-18') }),
      { action: 'label', designation: 'Flop', designationBasis: 'no-recoupment-announced' });
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(200) },
      entry: { ...researched, estimatedRecoupmentPct: [5, 15] }, now: NOW,
    });
    assert.equal(r.designation, 'Flop');
  });

  it('escalates to human-review when show was NEVER deep-researched', () => {
    // Producer-reputation safety: never auto-Fizzle a show our scraper hasn't
    // actually tried to find recoupment news for. Pre-Friday-scraper shows
    // (closed before May 2026) have no signal because we never looked, not
    // because the show flopped.
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD' },  // no researchAttempts, no researchedAt
      pending: null, archive: null, now: NOW,
    });
    assert.equal(r.action, 'human-review');
    assert.ok(r.reason.includes('deep-research never ran'));
  });

  it('skips when status is not closed', () => {
    const r = classifyStaleClosure({
      show: { status: 'open', closingDate: daysBefore(45) },
      entry: { designation: 'TBD' }, now: NOW,
    });
    assert.equal(r.action, 'no-change');
  });

  it('skips when too old (>365 days)', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(400) },
      entry: { designation: 'TBD' }, now: NOW,
    });
    assert.equal(r.action, 'no-change');
    assert.ok(r.reason.includes('too-old'));
  });

  it('still classifies a researched TBD record past the age cap (BRO-4985)', () => {
    // our-town closed 629 days before deep-research finished; the age cap
    // left it TBD forever.
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(629) },
      entry: { designation: 'TBD', researchAttempts: 1, lastResearchedAt: daysBefore(20) },
      pending: null, archive: null, now: NOW,
    });
    assert.equal(r.action, 'classify-fizzle');
    assert.equal(r.designationBasis, DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED);
  });

  it('honors humanReviewedDesignation lock', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD', humanReviewedDesignation: true }, now: NOW,
    });
    assert.equal(r.action, 'no-change');
    assert.ok(r.reason.includes('humanReviewedDesignation'));
  });

  it('skips already-recouped shows', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'Easy Winner', recouped: true }, now: NOW,
    });
    assert.equal(r.action, 'no-change');
    assert.ok(r.reason.includes('recouped'));
  });

  it('skips already-classified Flop / Fizzle', () => {
    for (const d of ['Flop', 'Fizzle']) {
      const r = classifyStaleClosure({
        show: { status: 'closed', closingDate: daysBefore(45) },
        entry: { designation: d }, now: NOW,
      });
      assert.equal(r.action, 'no-change', `should skip designation=${d}`);
    }
  });

  it('skips pure Nonprofit', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'Nonprofit' }, now: NOW,
    });
    assert.equal(r.action, 'no-change');
  });

  it('skips tour-stop / return-engagement / international-transfer production types', () => {
    for (const pt of ['tour-stop', 'return-engagement', 'international-transfer', 'International Transfer']) {
      const r = classifyStaleClosure({
        show: { status: 'closed', closingDate: daysBefore(45) },
        entry: { designation: 'TBD', productionType: pt }, now: NOW,
      });
      assert.equal(r.action, 'skip-carve-out', `should carve out ${pt}`);
    }
  });

  it('escalates enhancement deals to human review', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD', productionType: 'enhancement', nonprofitOrg: 'Lincoln Center Theater' },
      now: NOW,
    });
    assert.equal(r.action, 'human-review');
    assert.ok(r.reason.includes('enhancement'));
  });

  it('escalates when a late recoupment signal landed in pending', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD' },
      pending: { recouped: true, researchedAt: daysBefore(5), detectedBy: 'rss-poller' },
      archive: null, now: NOW,
    });
    assert.equal(r.action, 'human-review');
    assert.ok(r.reason.includes('late-recoupment-signal'));
  });

  it('escalates when archive has a recoupment signal in the last 30 days', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD' },
      pending: null,
      archive: { _recoupedClaim: true, detectedAt: daysBefore(20), detectedBy: 'recoupment-announcement-scraper' },
      now: NOW,
    });
    assert.equal(r.action, 'human-review');
  });

  it('does NOT escalate when the recoupment signal is older than recentSignalDays', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD', researchAttempts: 1, lastResearchedAt: daysBefore(10) },
      pending: { recouped: true, researchedAt: daysBefore(60), detectedBy: 'rss-poller' },
      archive: null, now: NOW,
    });
    assert.equal(r.action, 'flag-needs-loss-evidence');
  });

  it('handles missing closingDate', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed' }, entry: {}, now: NOW,
    });
    assert.equal(r.action, 'no-change');
    assert.ok(r.reason.includes('no closingDate'));
  });

  it('escalates uncovered shows (never researched) to human-review', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: undefined, now: NOW,
    });
    assert.equal(r.action, 'human-review');
  });

  it('respects custom thresholds and treats deepResearch.verifiedDate as research evidence', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(20) },
      entry: { designation: 'TBD', deepResearch: { verifiedDate: daysBefore(40) } },
      now: NOW, thresholds: { graceDays: 15 },
    });
    assert.equal(r.action, 'flag-needs-loss-evidence');
  });
});

describe('undoAutoFizzleOnRunningShow', () => {
  it('clears the classifier label and its designationBasis when the show runs again', () => {
    const entry = {
      designation: 'Flop', recouped: false, designationBasis: DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED,
      recoupedSource: 'Inferred: closed 200 days ago, no trade-press recoupment found',
      classifiedBy: 'classify-stale-closures', classifiedAt: 'x', classifiedReason: 'y',
    };
    const out = undoAutoFizzleOnRunningShow(entry, { status: 'open' });
    assert.equal(out.designation, 'TBD');
    assert.equal(out.recouped, null);
    assert.equal('designationBasis' in out, false);
    assert.equal('classifiedBy' in out, false);
  });

  it('leaves a hand-set or cited loss alone', () => {
    const base = { designation: 'Fizzle', classifiedBy: 'classify-stale-closures', recouped: false };
    assert.equal(undoAutoFizzleOnRunningShow({ ...base, humanReviewedDesignation: true }, { status: 'open' }), null);
    assert.equal(undoAutoFizzleOnRunningShow({ ...base, recoupedSource: 'NYT: did not recoup' }, { status: 'open' }), null);
    assert.equal(undoAutoFizzleOnRunningShow({ ...base, classifiedBy: undefined }, { status: 'open' }), null);
  });

  it('also undoes a silence-basis label another writer set (cleanup, backfill)', () => {
    const row = { designation: 'Fizzle', recouped: false, designationBasis: DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED, recoupedSource: 'No recoupment announced' };
    const out = undoAutoFizzleOnRunningShow(row, { status: 'open' });
    assert.equal(out.designation, 'TBD');
    assert.equal('designationBasis' in out, false);
    assert.equal(out.recoupedSource, 'No recoupment announced');
    assert.equal(undoAutoFizzleOnRunningShow({ ...row, designationBasis: 'reported-loss' }, { status: 'open' }), null);
    assert.equal(undoAutoFizzleOnRunningShow(row, { status: 'closed' }), null);
  });
});

describe('closedTbdLossAction (cleanup-commercial-data step 4, policy B)', () => {
  const closed = (d) => ({ status: 'closed', closingDate: daysBefore(d), title: 'X' });
  it('labels a closed TBD 6+ months on with the silence basis, flags a recent one', () => {
    assert.deepEqual(closedTbdLossAction({ designation: 'TBD' }, closed(400), { now: NOW }),
      { action: 'label', designation: 'Fizzle', designationBasis: 'no-recoupment-announced' });
    assert.deepEqual(closedTbdLossAction({ designation: 'TBD' }, closed(60), { now: NOW }), { action: 'flag' });
  });
  it('leaves locked, recouped, non-TBD, running, already-ruled rows alone', () => {
    assert.equal(closedTbdLossAction({ designation: 'TBD', humanReviewedDesignation: true }, closed(400), { now: NOW }), null);
    assert.equal(closedTbdLossAction({ designation: 'TBD', recouped: true }, closed(400), { now: NOW }), null);
    assert.equal(closedTbdLossAction({ designation: 'Fizzle' }, closed(400), { now: NOW }), null);
    assert.equal(closedTbdLossAction({ designation: 'TBD' }, { status: 'open' }, { now: NOW }), null);
    assert.equal(closedTbdLossAction({ designation: 'TBD', needsLossEvidence: false }, closed(60), { now: NOW }), null);
  });
  it('skips tours and transfers, like the classifier', () => {
    assert.equal(closedTbdLossAction({ designation: 'TBD', productionType: 'tour-stop' }, closed(400), { now: NOW }), null);
  });
  it('the kill switch flags instead of labelling', () => {
    assert.deepEqual(closedTbdLossAction({ designation: 'TBD' }, closed(400), { now: NOW, requireLossEvidence: true }), { action: 'flag' });
  });
});
