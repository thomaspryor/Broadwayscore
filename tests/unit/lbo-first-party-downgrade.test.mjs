/**
 * Unit tests for the LBO first-party exemption in getBestScore's WE-aggregator
 * downgrade.
 *
 * London Box Office publishes BOTH multi-outlet roundups AND first-party
 * bylined reviews by its own editorial team (Stuart King, Nicola Wright,
 * Shehrazade Zafar-Arif). Only the roundups should take the WE-aggregator
 * downgrade; a first-party byline's bstarsN class IS the critic's published
 * rating. The 2026-04-26 fix (commit 1e1fad9d2e) keyed the exemption on
 * `data.source === 'lbo-individual'` alone — but `source` is only the LAST
 * writer to touch the file, and 30 first-party LBO bylines carry
 * 'lbo-individual' in `sources[]` under a different primary source (12 of them
 * 'lbo-roundup', which IS in AGGREGATOR_SOURCES). Those kept getting the
 * downgrade. Aggregator/first-party split audit 2026-08-02.
 *
 * Run: node --test tests/unit/lbo-first-party-downgrade.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getBestScore } = require('../../scripts/lib/rebuild-helpers');

// A West End review from LBO whose only score is the bstarsN star the scraper
// wrote into aggregatorStars. With the exemption the star wins (P0.5); without
// it the WE-aggregator downgrade drops aggregatorStars and nothing scores.
function lboFile(extra = {}) {
  return {
    showId: 'test-show',
    outletId: 'london-box-office',
    criticName: 'Stuart King',
    url: 'https://www.londonboxoffice.co.uk/news/post/test-show-apollo-theatre-review',
    _showCategory: 'west-end',
    aggregatorStars: '4/5',
    scoreSource: 'lbo-css-stars',
    ...extra,
  };
}

describe('LBO first-party exemption from the WE-aggregator downgrade', () => {
  it('source === lbo-individual → star wins (the original 2026-04-26 fix)', () => {
    const res = getBestScore(lboFile({ source: 'lbo-individual', sources: ['lbo-individual'] }));
    assert.strictEqual(res.score, 80);
  });

  it('sources[] includes lbo-individual under a lbo-roundup primary → star wins', () => {
    const res = getBestScore(lboFile({ source: 'lbo-roundup', sources: ['lbo-roundup', 'lbo-individual'] }));
    assert.strictEqual(res.score, 80);
  });

  it('sources[] includes lbo-individual under a serp-discovery primary → star wins', () => {
    const res = getBestScore(lboFile({ source: 'serp-discovery', sources: ['serp-discovery', 'lbo-individual'] }));
    assert.strictEqual(res.score, 80);
  });

  it('pure roundup (no lbo-individual anywhere) → downgraded, star does NOT score', () => {
    const res = getBestScore(lboFile({ source: 'lbo-roundup', sources: ['lbo-roundup'] }));
    assert.strictEqual(res, null);
  });

  it('exemption is outlet-scoped: lbo-individual on a non-LBO outletId does not apply', () => {
    const res = getBestScore(lboFile({
      outletId: 'westendtheatre',
      source: 'lbo-roundup',
      sources: ['lbo-roundup', 'lbo-individual'],
    }));
    assert.strictEqual(res, null);
  });

  // `sources[]` is append-only merge history, so a stale 'lbo-individual'
  // token can ride along on a file whose CURRENT payload is a roundup page.
  // The URL is the content-identity check that stops it.
  it('roundup URL + stale lbo-individual in sources[] → NOT exempt (no star)', () => {
    const res = getBestScore(lboFile({
      source: 'lbo-roundup',
      sources: ['lbo-individual', 'lbo-roundup'],
      url: 'https://www.londonboxoffice.co.uk/news/post/review-round-up-test-show-apollo',
    }));
    assert.strictEqual(res, null);
  });

  it('roundup URL + source === lbo-individual → still NOT exempt', () => {
    const res = getBestScore(lboFile({
      source: 'lbo-individual',
      sources: ['lbo-individual'],
      url: 'https://www.londonboxoffice.co.uk/news/post/Review-Round-Up%3A-TEST-SHOW-Apollo',
    }));
    assert.strictEqual(res, null);
  });

  it('missing url is not a crash and does not exempt via roundup check', () => {
    const data = lboFile({ source: 'lbo-individual', sources: ['lbo-individual'] });
    delete data.url;
    assert.strictEqual(getBestScore(data).score, 80);
  });

  it('missing sources[] is not a crash (legacy files predate the array)', () => {
    const data = lboFile({ source: 'lbo-roundup' });
    delete data.sources;
    assert.strictEqual(getBestScore(data), null);
  });
});
