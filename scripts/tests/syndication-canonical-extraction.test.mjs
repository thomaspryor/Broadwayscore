// BRO-3188: syndicated reprints are canonical-source EXTRACTION inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('../lib/syndication-canonical.js');
const { OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('../lib/url-discovery.js');

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const isRegisteredOutletUrl = lib.makeRegisteredOutletPredicate(OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES);
const REPRINT = 'https://msnbctv.news/tilda-swinton-man-to-man';
const INDEP = 'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/man-to-man-tilda-swinton-review-royal-court-b3048691.html';

test('independent.co.uk is a registered outlet (fixture precondition)', () => {
  assert.equal(isRegisteredOutletUrl(INDEP), true);
  assert.equal(isRegisteredOutletUrl('https://random-gossip-blog.example/post'), false);
});

test('syndication hosts are recognised, outlets are not', () => {
  for (const u of ['https://msnbctv.news/x', 'https://www.msn.com/en-gb/x', 'https://uk.news.yahoo.com/x',
    'https://www.aol.co.uk/x', 'https://news.google.com/x', 'https://apple.news/x']) {
    assert.equal(lib.isSyndicationHost(u), true, u);
  }
  assert.equal(lib.isSyndicationHost(INDEP), false);
});

test('(1) rel=canonical to a registered outlet yields that URL', async () => {
  const r = await lib.resolveSyndicatedHit(REPRINT, { fetch: async () => fx('msnbctv-man-to-man-reprint.html'), isRegisteredOutletUrl });
  assert.deepEqual(r, { url: INDEP, via: 'canonical' });
});

test('(2) self-canonical reprint falls back to first in-body registered-outlet link', async () => {
  const r = await lib.resolveSyndicatedHit(REPRINT, { fetch: async () => fx('msnbctv-self-canonical-reprint.html'), isRegisteredOutletUrl });
  assert.equal(r.via, 'body-link');
  assert.equal(r.url, INDEP); // query stripped
});

test('(3) non-outlet page yields no URL; fetch failure and non-syndicated URLs yield null', async () => {
  assert.equal(await lib.resolveSyndicatedHit(REPRINT, { fetch: async () => fx('msnbctv-no-outlet-page.html'), isRegisteredOutletUrl }), null);
  assert.equal(await lib.resolveSyndicatedHit(REPRINT, { fetch: async () => { throw new Error('x'); }, isRegisteredOutletUrl }), null);
  assert.equal(await lib.resolveSyndicatedHit(INDEP, { fetch: async () => { throw new Error('must not fetch'); }, isRegisteredOutletUrl }), null);
});

test('isRejectedUrl vetoes a canonical (blocked/aggregator targets)', () => {
  const r = lib.extractCanonicalSourceUrl(fx('msnbctv-man-to-man-reprint.html'), REPRINT,
    { isRegisteredOutletUrl, isRejectedUrl: () => true });
  assert.equal(r, null);
});

// Wiring guard: both open-ended SERP loops (Strategy 2 news, 2b broad web)
// must resolve hits through resolveSerpHitUrl, or reprints are dropped again.
test('discover-opening-night-reviews resolves syndicated hits in Strategy 2 and 2b', () => {
  const src = fs.readFileSync(new URL('../discover-opening-night-reviews.js', import.meta.url), 'utf8');
  const uses = src.match(/await resolveSerpHitUrl\(result\.url \|\| result\.link, showTitle\)/g) || [];
  assert.equal(uses.length, 2);
});

test('homepages, data-href decoys, unquoted attrs and commented links', () => {
  const o = { isRegisteredOutletUrl };
  assert.equal(lib.extractCanonicalSourceUrl('<link rel="canonical" href="https://www.independent.co.uk/">', REPRINT, o), null);
  const decoy = '<a data-href="https://www.nytimes.com/a/b/c" href=' + INDEP + '>x</a>';
  assert.equal(lib.extractCanonicalSourceUrl(decoy, REPRINT, o).url, INDEP);
  const commented = '<!-- <a href="https://www.nytimes.com/a/b/c">x</a> --><a href="' + INDEP + '">x</a>';
  assert.equal(lib.extractCanonicalSourceUrl(commented, REPRINT, o).url, INDEP);
});

test('the fetch of a reprint must skip the canonical/url_mismatch guard', () => {
  const src = fs.readFileSync(new URL('../discover-opening-night-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /fetchPage\(u, \{ skipVerify: true \}\)/);
});
