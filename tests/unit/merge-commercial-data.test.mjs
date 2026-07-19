// Unit tests for scripts/lib/merge-commercial-data.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  mergeCommercialJson,
  mergePendingReview,
  mergeResearchQueue,
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

describe('mergeResearchQueue', () => {
  it('unions slugs from both sides with no duplicates', () => {
    const ours = { shows: ['giant', 'ragtime'], triggers: { giant: 'closing' } };
    const remote = { shows: ['ragtime', 'hairspray'], triggers: { hairspray: 'pre-opening' } };
    const { merged, stats } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, ['giant', 'ragtime', 'hairspray']);
    assert.equal(stats.added, 1, 'only hairspray is a genuinely new slug');
  });

  it('does not silently drop local-only slugs (the bug this fixes)', () => {
    // Simulates the exact regression: local run added a slug that the remote
    // side never saw. The old "accept remote" behavior would have dropped it.
    const ours = { shows: ['locally-added-slug'], triggers: {} };
    const remote = { shows: [], triggers: {} };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.ok(merged.shows.includes('locally-added-slug'));
  });

  it('merges triggers from both sides', () => {
    const ours = { shows: ['a'], triggers: { a: 'closing' } };
    const remote = { shows: ['b'], triggers: { b: 'pre-opening' } };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.equal(merged.triggers.a, 'closing');
    assert.equal(merged.triggers.b, 'pre-opening');
  });

  it('picks the newer updatedAt', () => {
    const ours = { shows: [], triggers: {}, updatedAt: '2026-07-14T09:00:00.000Z' };
    const remote = { shows: [], triggers: {}, updatedAt: '2026-07-15T09:36:30.155Z' };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.equal(merged.updatedAt, '2026-07-15T09:36:30.155Z');
  });

  it('handles null/empty inputs gracefully', () => {
    assert.deepEqual(mergeResearchQueue(null, null).merged.shows, []);
    assert.deepEqual(mergeResearchQueue({}, {}).merged.shows, []);
  });

  it('does NOT resurrect slugs a newer consumption clear already processed (ship-check finding)', () => {
    // ours is a stale pre-consumption snapshot still carrying 'giant';
    // remote is deep-research-commercial.js's clear, written after
    // processing it. A plain union would re-add 'giant' forever.
    const ours = { shows: ['giant', 'ragtime'], triggers: { giant: 'closing', ragtime: 'pre-opening' }, updatedAt: '2026-07-19T09:00:00.000Z' };
    const remote = { shows: [], updatedAt: '2026-07-19T10:00:00.000Z' };
    const { merged, stats } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, [], 'consumed slugs must not be resurrected');
    assert.equal(stats.resolvedAsConsumption, 'remote');
  });

  it('does NOT resurrect when local side is the newer consumption clear', () => {
    const ours = { shows: [], updatedAt: '2026-07-19T10:00:00.000Z' };
    const remote = { shows: ['giant'], triggers: { giant: 'closing' }, updatedAt: '2026-07-19T09:00:00.000Z' };
    const { merged, stats } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, []);
    assert.equal(stats.resolvedAsConsumption, 'ours');
  });

  it('still unions a producer add that lands AFTER an older consumption clear', () => {
    // remote's clear is OLDER than ours' add — this is the normal case
    // (queue producer runs after the researcher already cleared it), not a
    // race, so the new slug must still be picked up.
    const ours = { shows: ['newly-queued'], triggers: { 'newly-queued': 'closing' }, updatedAt: '2026-07-19T11:00:00.000Z' };
    const remote = { shows: [], updatedAt: '2026-07-19T09:00:00.000Z' };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, ['newly-queued']);
  });
});
