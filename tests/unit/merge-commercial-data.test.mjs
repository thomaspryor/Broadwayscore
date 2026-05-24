// Unit tests for scripts/lib/merge-commercial-data.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  mergeCommercialJson,
  mergePendingReview,
} = require('../../scripts/lib/merge-commercial-data');

describe('mergeCommercialJson', () => {
  it('returns union of slugs when no overlap', () => {
    const ours = { shows: { 'a': { designation: 'Hit' } } };
    const remote = { shows: { 'b': { designation: 'Flop' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote);
    assert.equal(Object.keys(merged.shows).length, 2);
    assert.ok(merged.shows.a);
    assert.ok(merged.shows.b);
    assert.equal(stats.added, 1);
  });

  it('picks the newer entry on lastUpdated when both sides have the slug', () => {
    const ours = { shows: { 'a': { designation: 'TBD', lastUpdated: '2026-01-01T00:00:00.000Z' } } };
    const remote = { shows: { 'a': { designation: 'Easy Winner', lastUpdated: '2026-05-24T00:00:00.000Z' } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.designation, 'Easy Winner');
  });

  it('preserves humanReviewedDesignation from the loser side', () => {
    // ours is newer, remote has the manual review flag — manual must survive
    const ours = { shows: { 'a': { designation: 'Easy Winner', lastUpdated: '2026-05-24T00:00:00.000Z' } } };
    const remote = { shows: { 'a': {
      designation: 'TBD',
      humanReviewedDesignation: true,
      lastUpdated: '2026-05-23T00:00:00.000Z',
    } } };
    const { merged, stats } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.designation, 'Easy Winner', 'newer designation wins');
    assert.equal(merged.shows.a.humanReviewedDesignation, true, 'manual review flag must survive merge');
    assert.equal(stats.overlaid, 1);
  });

  it('preserves humanReviewedRecouped flag', () => {
    const ours = { shows: { 'a': { recouped: false, lastUpdated: '2026-05-24T00:00:00.000Z' } } };
    const remote = { shows: { 'a': {
      recouped: true,
      humanReviewedRecouped: true,
      lastUpdated: '2026-05-01T00:00:00.000Z',
    } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.recouped, false, 'newer wins for non-protected fields');
    assert.equal(merged.shows.a.humanReviewedRecouped, true, 'human flag overlaid from loser');
  });

  it('handles missing lastUpdated by falling back to firstAdded', () => {
    const ours = { shows: { 'a': { designation: 'TBD', firstAdded: '2026-04-01T00:00:00.000Z' } } };
    const remote = { shows: { 'a': { designation: 'Flop', firstAdded: '2026-05-01T00:00:00.000Z' } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.designation, 'Flop');
  });

  it('handles null/empty inputs gracefully', () => {
    assert.deepEqual(mergeCommercialJson(null, null).merged.shows, {});
    assert.deepEqual(mergeCommercialJson({}, {}).merged.shows, {});
  });

  it('preserves _meta.lastUpdated to the newer side', () => {
    const ours = { shows: {}, _meta: { lastUpdated: '2026-05-01' } };
    const remote = { shows: {}, _meta: { lastUpdated: '2026-05-24', designations: { Miracle: {} } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged._meta.lastUpdated, '2026-05-24');
    assert.ok(merged._meta.designations, 'designations carried from remote');
  });
});

describe('mergePendingReview', () => {
  it('unions pending entries from both sides', () => {
    const ours = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-05-24T00:00:00.000Z' } } };
    const remote = { shows: { 'ragtime': { confidence: 'low', researchedAt: '2026-04-01T00:00:00.000Z' } } };
    const { merged, stats } = mergePendingReview(ours, remote);
    assert.equal(Object.keys(merged.shows).length, 2);
    assert.equal(stats.added, 1);
  });

  it('picks newer entry on researchedAt for conflicting slugs', () => {
    const ours = { shows: { 'giant': { confidence: 'medium', researchedAt: '2026-05-20T00:00:00.000Z' } } };
    const remote = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-05-24T00:00:00.000Z' } } };
    const { merged } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high');
  });

  it('falls back to detectedAt if researchedAt is missing', () => {
    const ours = { shows: { 'giant': { confidence: 'medium', detectedAt: '2026-05-20T00:00:00.000Z' } } };
    const remote = { shows: { 'giant': { confidence: 'high', detectedAt: '2026-05-24T00:00:00.000Z' } } };
    const { merged } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high');
  });
});
