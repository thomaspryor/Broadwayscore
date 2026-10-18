// BRO-2263: confirmed domain moves must clear the health-check detector AND
// pass the same domain guard that review-file-writer uses before ingest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outlets } = require('../../data/outlet-registry.json');
const { findProbableDomainMoves } = require('../../scripts/lib/silent-exclusion-detectors');
const { validateUrlDomain } = require('../../scripts/lib/url-discovery');
const { resolveOutletFromUrl, outletOwnsUrlDomain } = require('../../scripts/lib/review-normalization');

// Ownership evidence: the Berkshire archive explicitly names BerkshireOnStage.com:
// https://berkshireonstage.blog/2012/06/04/fact-checking-journalist-dorothy-thompson-in-cassandra-speaks-a-burns-cane-review/
// North West End's current site links its archive on the older .co.uk domain:
// https://northwestend.com/
const moves = [
  {
    outletId: 'berkshire-on-stage',
    host: 'berkshireonstage.blog',
    url: 'https://berkshireonstage.blog/2024/11/16/review-the-lion-king-at-the-bushnell/',
  },
  {
    outletId: 'north-west-end',
    host: 'northwestend.co.uk',
    url: 'https://northwestend.co.uk/index.php/professional-reviews/773-king-lear-royal-exchange-manchester',
  },
];

for (const { outletId, host, url } of moves) {
  test(`${host} is registered to ${outletId}`, () => {
    assert.ok(outlets[outletId].domainAliases?.includes(host));
    assert.equal(resolveOutletFromUrl(url)?.outletId, outletId);
  });

  test(`${host} passes the ingest domain guard, including www`, () => {
    for (const candidate of [url, url.replace('https://', 'https://www.'), `https://${outlets[outletId].domain}/`]) {
      assert.deepEqual(validateUrlDomain(candidate, outletId), { valid: true }, candidate);
    }
  });

  test(`${host} clears the detector even in a stale unknown-outlet census`, () => {
    assert.deepEqual(findProbableDomainMoves(outlets, [{ host, sampleUrls: [url] }]), []);
    // Removing just this alias must reproduce the original finding. This
    // exercises the real detector rather than reimplementing its matching.
    const before = {
      ...outlets,
      [outletId]: {
        ...outlets[outletId],
        domainAliases: outlets[outletId].domainAliases.filter(alias => alias !== host),
      },
    };
    assert.deepEqual(findProbableDomainMoves(before, [{ host }]).map(move => move.outletId), [outletId]);
  });
}

test('the original TheatreReviews.design finding remains a distinct registered outlet', () => {
  const url = 'https://theatrereviews.design/';
  assert.equal(resolveOutletFromUrl(url)?.outletId, 'theatrereviews-design');
  assert.deepEqual(validateUrlDomain(url, 'theatrereviews-design'), { valid: true });
  assert.equal(validateUrlDomain(url, 'theatre-reviews-limited').valid, false);
  assert.deepEqual(findProbableDomainMoves(outlets, [{ host: 'theatrereviews.design' }]), []);
});

test('Gay Times already has its confirmed alias and does not re-alert', () => {
  assert.ok(outlets['gay-times'].domainAliases.includes('gaytimes.com'));
  assert.deepEqual(validateUrlDomain('https://www.gaytimes.com/', 'gay-times'), { valid: true });
  assert.deepEqual(findProbableDomainMoves(outlets, [{ host: 'gaytimes.com' }]), []);
});

test('similar publication names do not authorize unrelated or regional domains', () => {
  for (const [host, outletId] of [
    ['independent.ie', 'santa-barbara-independent'],
    ['artshub.com.au', 'artshub'],
    ['billboard.com.br', 'billboard'],
    ['notberkshireonstage.blog', 'berkshire-on-stage'],
  ]) {
    assert.equal(outletOwnsUrlDomain(outletId, `https://${host}/`), false, host);
  }
});
