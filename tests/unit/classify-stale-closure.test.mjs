// Unit tests for scripts/lib/classify-stale-closure.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { classifyStaleClosure } = require('../../scripts/lib/classify-stale-closure');

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

  it('classifies Fizzle for TBD entry closed 30+ days ago that WAS researched, no signal', () => {
    const r = classifyStaleClosure({
      show: { status: 'closed', closingDate: daysBefore(45) },
      entry: { designation: 'TBD', researchAttempts: 1, lastResearchedAt: daysBefore(20) },
      pending: null, archive: null, now: NOW,
    });
    assert.equal(r.action, 'classify-fizzle');
    assert.equal(r.designation, 'Fizzle');
    assert.equal(r.confidence, 'high');
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
    assert.equal(r.action, 'classify-fizzle');
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
    assert.equal(r.action, 'classify-fizzle');
  });
});
