// BRO-7147: matcher classes behind the opening-review gap report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyGapCandidateUrl } = require('./non-review-url-patterns.js');
const { platformOriginMirrorOf } = require('./outlet-canonicalize.js');
const { citedUncollectedNow } = require('./audit-show-review-gap.js');

test('affiliate click-redirect links are never review candidates', () => {
  for (const u of ['https://www.tkqlhce.com/click-8360975-13869954', 'https://www.anrdoezrs.net/links/1/type/dlg/x',
    'https://www.awin1.com/cread.php?awinmid=1', 'https://prf.hn/click/camref:1/destination:x']) {
    assert.equal(classifyGapCandidateUrl(u).ok, false, u);
  }
  assert.equal(classifyGapCandidateUrl('https://www.unmissabletheatre.co.uk/reviews/review-ceilidh-at-shoreditch-town-hall').ok, true);
});

test('a Squarespace origin copy dedupes only against a held same-path review', () => {
  const origin = 'https://herring-gerbil-e2c7.squarespace.com/reviews/review-ceilidh-at-shoreditch-town-hall';
  const held = ['https://www.unmissabletheatre.co.uk/reviews/review-ceilidh-at-shoreditch-town-hall/'];
  const hit = platformOriginMirrorOf({ candidateUrl: origin, heldUrls: held });
  assert.equal(hit.dup, true);
  assert.equal(hit.matchedUrl, held[0]);
  // No held twin: still a real candidate (King of the Yees origin URL).
  assert.equal(platformOriginMirrorOf({ candidateUrl: 'https://synthesizer-accordion-e2w3.squarespace.com/king-of-the-yees-at-signature-theatre',
    heldUrls: ['https://thefrontrowcenter.com/2026/10/king-of-the-yees/'] }).dup, false);
  // A named Squarespace blog is not a generated origin.
  assert.equal(platformOriginMirrorOf({ candidateUrl: 'https://matthew-freeman.squarespace.com/the-ask', heldUrls: ['https://example.com/the-ask'] }).dup, false);
});

test('cited-missing count ignores census hits and reviews collected since the audit', () => {
  const row = { showId: 's', missing: [
    { url: 'https://www.nytimes.com/2026/10/21/theater/s-review.html' },
    { url: 'https://www.timeout.com/newyork/theater/s-review' },
    { url: 'https://someblog.com/s-review', serpCensus: true },
  ] };
  assert.equal(citedUncollectedNow(row), 2);
  assert.equal(citedUncollectedNow(row, { heldFiles: [{ url: 'https://nytimes.com/2026/10/21/theater/s-review.html/' }] }), 1);
  const blocklist = { urls: new Set(['https://www.timeout.com/newyork/theater/s-review']), entries: [{ url: 'https://www.timeout.com/newyork/theater/s-review' }] };
  assert.equal(citedUncollectedNow(row, { blocklist }), 1);
  assert.equal(citedUncollectedNow(null), null);
});
