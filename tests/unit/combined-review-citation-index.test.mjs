/**
 * BRO-3794 — buildAggregatorCitationIndex, the way out of the combined-review
 * deadlock.
 *
 * Two guards disagreed about which comes first: url-ownership.js refuses a
 * second copy of a URL under another show unless the owning copy is already
 * isCombinedReview, and flag-combined-reviews.js only sets isCombinedReview
 * once 2+ copies exist. A genuine multi-show article collected for show A
 * first was therefore permanently uncollectable for show B — the flagger
 * waited for a copy the ownership guard would never allow. 502 corpus URLs sit
 * in that state today.
 *
 * The index reads the second signal we already commit but never used: the gap
 * audit's record that show B is MISSING this URL, i.e. a Playbill Verdict /
 * BWW Review Roundup cited it as a review of B.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAggregatorCitationIndex } = require('../../scripts/lib/combined-review-utils');

// Same shape as flag-combined-reviews.js's own normalizer — the index must be
// keyed identically to the on-disk URL map it merges into, or it silently
// indexes nothing.
const normalizeUrl = (url) => {
  if (!url) return null;
  return url.trim().replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
};

const ROUNDUP = 'https://www.interestedbystander.com/2026/08/theater-reviews-in-late-summer-new.html';

describe('buildAggregatorCitationIndex', () => {
  test('indexes a missing URL under the show whose roundup cited it', () => {
    const index = buildAggregatorCitationIndex([
      { showId: 'disruption-off-broadway-2026', missing: [{ url: ROUNDUP, host: 'interestedbystander.com' }] },
    ], normalizeUrl);
    const owners = index.get(normalizeUrl(ROUNDUP));
    assert.ok(owners, 'expected the cited URL to be indexed');
    assert.deepEqual([...owners], ['disruption-off-broadway-2026']);
  });

  test('a URL cited as missing by several shows collects all of them', () => {
    const index = buildAggregatorCitationIndex([
      { showId: 'disruption-off-broadway-2026', missing: [{ url: ROUNDUP }] },
      { showId: 'the-vessel-off-broadway-2026', missing: [{ url: ROUNDUP }] },
    ], normalizeUrl);
    assert.deepEqual([...index.get(normalizeUrl(ROUNDUP))].sort(),
      ['disruption-off-broadway-2026', 'the-vessel-off-broadway-2026']);
  });

  test('reads `missing` only — a merely-listed aggregator URL is not evidence of a block', () => {
    // Scoping to `missing` is load-bearing: widening to aggregatorListedUrls
    // newly flagged 297 corpus files isCombinedReview (measured), exempting
    // each from the cross-show contamination guards, to unstick 2.
    const index = buildAggregatorCitationIndex([
      { showId: 'some-show-2026', aggregatorListedUrls: [ROUNDUP], missing: [] },
    ], normalizeUrl);
    assert.equal(index.size, 0);
  });

  test('accepts bare-string missing entries as well as {url} objects', () => {
    const index = buildAggregatorCitationIndex([
      { showId: 'a-show-2026', missing: [ROUNDUP] },
    ], normalizeUrl);
    assert.deepEqual([...index.get(normalizeUrl(ROUNDUP))], ['a-show-2026']);
  });

  test('normalizes so http/https, www. and a trailing slash all collapse together', () => {
    const index = buildAggregatorCitationIndex([
      { showId: 'a-2026', missing: [{ url: 'http://www.example.com/review/' }] },
      { showId: 'b-2026', missing: [{ url: 'https://example.com/review' }] },
    ], normalizeUrl);
    assert.equal(index.size, 1, 'the two spellings must land on one key');
    assert.deepEqual([...index.get('example.com/review')].sort(), ['a-2026', 'b-2026']);
  });

  test('survives junk input instead of throwing mid-run', () => {
    assert.equal(buildAggregatorCitationIndex(null, normalizeUrl).size, 0);
    assert.equal(buildAggregatorCitationIndex(undefined, normalizeUrl).size, 0);
    assert.equal(buildAggregatorCitationIndex([{}, { showId: null }], normalizeUrl).size, 0);
    assert.equal(buildAggregatorCitationIndex(
      [{ showId: 'x-2026', missing: [null, 42, { url: null }, {}] }], normalizeUrl).size, 0);
  });
});
