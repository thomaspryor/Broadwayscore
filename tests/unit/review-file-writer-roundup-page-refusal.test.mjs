// TESTS-VS-DERIVED-DATA-EXEMPT: guard logic test — reads shows.json only for show-id existence, asserts writer refusal behavior, no hardcoded facts.
// Guard E0 (review-file-writer.js): a roundup PAGE filed under the roundup
// host's own outletId is refused at the createOrMergeReviewFile chokepoint.
//
// Incident: discover-opening-night-reviews.js wrote
// other-desert-cities-2026/playbill--meg.json for Playbill's "what do the
// critics think of" roundup with a fetched fullText (contentTier complete).
// Guards E/E1 only stamped isRoundupArticle and wrote the file anyway.
//
// Chokepoint-guard parity: every host in review-guards.js ROUNDUP_HOST_OUTLETS
// (the rebuild-time page-as-review exclusion) must also be refused at write
// time. The host list is read from the guard's source so a new host added
// there without a sample URL here fails this test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
const { isRoundupPageAsReview } = require('../../scripts/lib/review-guards');

const ODC_URL = 'https://playbill.com/article/reviews-what-do-the-critics-think-of-other-desert-cities-on-broadway';
const BROADWAY_SHOW = 'other-desert-cities-2026';
const LONDON_SHOW = 'the-story-west-end-2026';

// One page-as-review sample per ROUNDUP_HOST_OUTLETS host: [url, hostOutletId, showId]
const SAMPLES = {
  'whatsonstage.com': ['https://www.whatsonstage.com/news/the-story-review-round-up_12345/', 'whatsonstage', LONDON_SHOW],
  'playbill.com': [ODC_URL, 'playbill', BROADWAY_SHOW],
  'bestoftheatre.co.uk': ['https://www.bestoftheatre.co.uk/blog/post/review-roundup-the-story-national-theatre', 'bestoftheatre', LONDON_SHOW],
  'britishtheatre.com': ['https://www.britishtheatre.com/posts/the-story-review-round-up', 'britishtheatrecom', LONDON_SHOW],
  'londontheatredirect.com': ['https://www.londontheatredirect.com/news/the-story-review-round-up', 'londontheatredirect', LONDON_SHOW],
  'independent.co.uk': ['https://www.independent.co.uk/arts-entertainment/theatre-dance/the-story-reviews-round-up-a1234.html', 'independent', LONDON_SHOW],
  'latimes.com': ['https://www.latimes.com/entertainment-arts/story/2026-01-01/other-desert-cities-what-did-the-critics-think', 'latimes', BROADWAY_SHOW],
  'standard.co.uk': ['https://www.standard.co.uk/culture/theatre/the-story-reviews-round-up-a1234.html', 'standard', LONDON_SHOW],
  'dailymail.co.uk': ['https://www.dailymail.co.uk/tvshowbiz/article-1234/The-Story-panned-by-critics.html', 'daily-mail', LONDON_SHOW],
  'dailymail.com': ['https://www.dailymail.com/tvshowbiz/article-1234/The-Story-wins-over-critics.html', 'mail-on-sunday', LONDON_SHOW],
  'thestage.co.uk': ['https://www.thestage.co.uk/review-round-ups/the-story-review-round-up', 'thestage', LONDON_SHOW],
  'londonboxoffice.co.uk': ['https://www.londonboxoffice.co.uk/news/post/Review-Round-Up%3A-THE-STORY', 'london-box-office', LONDON_SHOW],
  'westendtheatre.com': ['https://www.westendtheatre.com/123456/news/reviews/the-story-reviews/', 'westendtheatre', LONDON_SHOW],
  'goldderby.com': ['https://www.goldderby.com/theater/2026/other-desert-cities-broadway-revival-reviews/', 'goldderby', BROADWAY_SHOW],
  'broadwayworld.com': ['https://www.broadwayworld.com/article/Review-Roundup-OTHER-DESERT-CITIES-Opens-On-Broadway-20261001', 'broadwayworld', BROADWAY_SHOW],
};

function hostsInGuardSource() {
  const src = fs.readFileSync(require.resolve('../../scripts/lib/review-guards'), 'utf-8');
  const block = src.match(/const ROUNDUP_HOST_OUTLETS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'ROUNDUP_HOST_OUTLETS block not found in review-guards.js');
  return [...block[1].matchAll(/^\s*'([a-z0-9.-]+)':\s*\[/gm)].map(m => m[1]);
}

function withTmp(showId, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-roundup-refusal-'));
  fs.mkdirSync(path.join(tmp, showId), { recursive: true });
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function write(showId, tmp, { url, outletId, criticName = 'Meg Masseron' }) {
  return createOrMergeReviewFile(showId, {
    outletId,
    outlet: outletId,
    criticName,
    url,
    source: 'opening-night-discovery',
    fields: {
      publishDate: null,
      fullText: 'The critics are in for the Broadway revival. The New York Times calls it a triumph, while Variety found the second act slow. '.repeat(20),
      contentTier: 'complete',
    },
  }, { reviewTextsDir: tmp });
}

describe('Guard E0: roundup page as host-outlet review is refused', () => {
  test('ODC Playbill Verdict roundup under playbill → skipped, nothing written', () => {
    withTmp(BROADWAY_SHOW, (tmp) => {
      const result = write(BROADWAY_SHOW, tmp, { url: ODC_URL, outletId: 'playbill' });
      assert.equal(result.action, 'skipped');
      assert.match(result.reason, /^roundup-page-as-review: Playbill critics-think-of roundup/);
      assert.equal(result.durable, true, 'refusal is permanent');
      assert.deepEqual(fs.readdirSync(path.join(tmp, BROADWAY_SHOW)), []);
    });
  });

  test('a review SOURCED from a roundup under another outlet still writes, stamped (stamp-only path kept)', () => {
    // WET roundup row relayed under the quoted critic's own outlet: E0 keys on
    // outletId, so this is not page-as-review and the write lands. (A Playbill
    // URL can't show this: the writer refines a playbill.com URL's outlet to
    // 'playbill' before E0, which then correctly refuses it.)
    const url = SAMPLES['westendtheatre.com'][0];
    assert.equal(isRoundupPageAsReview({ url, outletId: 'telegraph' }), false);
    withTmp(LONDON_SHOW, (tmp) => {
      const result = createOrMergeReviewFile(LONDON_SHOW, {
        outletId: 'telegraph',
        outlet: 'The Telegraph',
        criticName: 'Dominic Cavendish',
        url,
        source: 'westendtheatre',
        fields: { publishDate: null, fullText: null, contentTier: 'excerpt', originalScore: '4/5' },
      }, { reviewTextsDir: tmp });
      assert.doesNotMatch(String(result.reason || ''), /roundup-page-as-review/);
      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
    });
  });

  test('a human clear passed in (isRoundupArticle:false) is honoured', () => {
    assert.equal(isRoundupPageAsReview({ url: ODC_URL, outletId: 'playbill', isRoundupArticle: false }), false);
  });

  test('chokepoint parity: every ROUNDUP_HOST_OUTLETS host has a sample here', () => {
    const missing = hostsInGuardSource().filter(h => !SAMPLES[h]);
    assert.deepEqual(missing, [], `add a page-as-review sample URL for: ${missing.join(', ')}`);
  });

  for (const [host, [url, outletId, showId]] of Object.entries(SAMPLES)) {
    test(`chokepoint parity: ${host} page-as-review is excluded at rebuild AND refused at write`, () => {
      assert.equal(isRoundupPageAsReview({ url, outletId }), true, `sample is not page-as-review per the guard: ${url}`);
      withTmp(showId, (tmp) => {
        const result = write(showId, tmp, { url, outletId });
        assert.equal(result.action, 'skipped', `writer wrote a ${host} roundup page as a ${outletId} review`);
        assert.match(result.reason, /^roundup-page-as-review:/);
        assert.deepEqual(fs.readdirSync(path.join(tmp, showId)), []);
      });
    });
  }
});
