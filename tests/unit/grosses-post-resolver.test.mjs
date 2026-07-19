// Unit tests for scripts/lib/grosses-post-resolver.js and the
// buildValidationSources() confidence-gating it feeds (S1-T6/T7 of the
// commercial-model-accuracy sprint plan).
// Per feedback_test_extraction_pattern.md — require() the real functions.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { buildGrossesPostResult } = require('../../scripts/lib/grosses-post-resolver');
const { buildValidationSources } = require('../../scripts/update-commercial-data');

describe('buildGrossesPostResult', () => {
  it('tags a tier-1 (author-scoped) match with no sourceConfidence', () => {
    const post = { title: 'Grosses Analysis: Week Ending 7/13/2026', selftext: 'text', permalink: '/r/x', created_utc: 1, author: 'Boring_Waltz_9545' };
    const result = buildGrossesPostResult(post, 1);
    assert.equal(result.sourceConfidence, undefined);
    assert.equal(result.author, 'Boring_Waltz_9545');
    assert.equal(result.weekEnding, '7/13/2026');
  });

  it('tags a tier-2 (profile feed) match with no sourceConfidence', () => {
    const post = { title: 'Grosses Analysis', selftext: '', permalink: '/r/y', created_utc: 2, author: 'Boring_Waltz_9545' };
    const result = buildGrossesPostResult(post, 2);
    assert.equal(result.sourceConfidence, undefined);
  });

  it('tags a tier-3 (generic search fallback) match as unverified-fallback', () => {
    const post = { title: 'Grosses Analysis', selftext: '', permalink: '/r/z', created_utc: 3, author: 'some_substitute_poster' };
    const result = buildGrossesPostResult(post, 3);
    assert.equal(result.sourceConfidence, 'unverified-fallback');
    assert.equal(result.author, 'some_substitute_poster', 'records the ACTUAL author, not the primary poster');
  });

  it('handles a missing author gracefully', () => {
    const post = { title: 'Grosses Analysis', selftext: '' };
    const result = buildGrossesPostResult(post, 3);
    assert.equal(result.author, null);
  });
});

describe('buildValidationSources (unverified-fallback gating)', () => {
  it('produces structured, corroborating sources for a trusted (tier 1/2) post', () => {
    const gathered = {
      grossesPost: { permalink: '/r/trusted', sourceConfidence: undefined },
      grossesPostParsed: [
        { matchedSlug: 'giant', estimatedWeeklyCost: 500000, estimatedRecoupmentPct: 40 },
      ],
    };
    const sources = buildValidationSources(gathered);
    const structured = sources.filter((s) => s.showSlug === 'giant');
    assert.equal(structured.length, 2, 'weeklyRunningCost + estimatedRecoupmentPct both structured');
    assert.equal(structured[0].sourceType, 'Reddit Grosses Analysis');
  });

  it('does NOT produce corroborating sources for an unverified-fallback post', () => {
    const gathered = {
      grossesPost: { permalink: '/r/unverified', sourceConfidence: 'unverified-fallback' },
      grossesPostParsed: [
        { matchedSlug: 'giant', showName: 'Giant', estimatedWeeklyCost: 500000, estimatedRecoupmentPct: 40 },
      ],
    };
    const sources = buildValidationSources(gathered);
    const structured = sources.filter((s) => s.showSlug === 'giant');
    assert.equal(structured.length, 0, 'no showSlug-keyed source — cannot corroborate a proposed change');
    const unstructured = sources.filter((s) => s.sourceType === 'Reddit Grosses Analysis (unverified fallback author)');
    assert.equal(unstructured.length, 1);
    assert.equal(unstructured[0].showSlug, null);
    assert.equal(unstructured[0].field, null);
  });
});
