// LIVE-DATA-LANE: reads data/site-image-versions.json (untracked core data); data/grosses.json (untracked core data); data/audience-buzz.json (untracked core data); +7 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-5399: the sitemap listed /compare/the-band-s-visit-2017-vs-* which 404ed,
 * because COMPARISON_PAIRS held a retired show slug. Every pair that reaches the
 * sitemap must resolve through the same lookup the compare page uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAllComparisonSlugs, parseComparisonSlug } from '../../src/config/comparisons';
import { getShowBySlug } from '../../src/lib/data-core';

test('every comparison slug resolves to two real shows', () => {
  const unresolved: string[] = [];
  for (const slug of getAllComparisonSlugs()) {
    const parsed = parseComparisonSlug(slug);
    if (!parsed || !getShowBySlug(parsed.showA) || !getShowBySlug(parsed.showB)) unresolved.push(slug);
  }
  assert.deepEqual(unresolved, [], `Comparison slugs that would 404 but sit in the sitemap: ${unresolved.join(', ')}`);
});
