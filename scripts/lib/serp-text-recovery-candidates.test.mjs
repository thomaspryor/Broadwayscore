import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateCandidate, buildDomainOutletIds } = require('./serp-text-recovery-candidates');
const { OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('./url-discovery');

function target(domain, overrides = {}) {
  return {
    domain,
    hasSerpKeys: true,
    domainOutletIds: buildDomainOutletIds(domain, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES),
    domainAliases: REGISTRY_DOMAIN_ALIASES,
    ...overrides,
  };
}

function review(host, overrides = {}) {
  return { outletId: 'theatre-and-tonic', url: `https://${host}/review`, contentTier: 'stub', ...overrides };
}

for (const [domain, host] of [
  ['theatreandtonic.com', 'theatreandtonic.co.uk'],
  ['theatreandtonic.co.uk', 'theatreandtonic.com'],
  ['vulture.com', 'www.nymag.com'],
  ['theater.nytimes.com', 'theater2.nytimes.com'],
]) {
  test(`existing URL on ${host} qualifies for registered alias ${domain}`, () => {
    assert.deepEqual(evaluateCandidate(review(host), target(domain), {}), { qualifies: true, skipReason: null });
  });
}

test('existing URLs qualify on the exact primary domain without an alias map or SERP keys', () => {
  assert.equal(evaluateCandidate(review('www.newyorker.com'), {
    domain: 'newyorker.com', hasSerpKeys: false,
  }).qualifies, true);
});

for (const host of ['unregistered.example', 'theatreandtonic.co.uk.evil.example', 'sub.theatreandtonic.com']) {
  test(`rejects unregistered hostname ${host} even when outletId matches`, () => {
    assert.deepEqual(evaluateCandidate(review(host), target('theatreandtonic.com'), {}), {
      qualifies: false, skipReason: 'wrong_domain',
    });
  });
}

test('malformed URLs remain rejected with aliases configured', () => {
  assert.equal(evaluateCandidate(review('theatreandtonic.co.uk', { url: 'not a URL' }),
    target('theatreandtonic.com'), {}).skipReason, 'bad_url');
});

for (const [overrides, reason] of [
  [{ contentTier: 'complete' }, 'complete'],
  [{ contentTier: 'invalid' }, 'not_thin'],
  ...['wrongShow', 'wrongProduction', 'wrongAttribution', 'isRoundupArticle'].map(flag => [{ [flag]: true }, 'flagged']),
]) {
  test(`alias matches preserve ${JSON.stringify(overrides)} exclusion`, () => {
    assert.deepEqual(evaluateCandidate(review('theatreandtonic.co.uk', overrides),
      target('theatreandtonic.com'), {}), { qualifies: false, skipReason: reason });
  });
}

test('exhausted alias URLs remain excluded', () => {
  const data = review('theatreandtonic.co.uk');
  assert.equal(evaluateCandidate(data, target('theatreandtonic.com'), {
    [data.url]: { reason: 'exhausted' },
  }).skipReason, 'exhausted');
});

test('alias URLs do not require SERP keys', () => {
  assert.equal(evaluateCandidate(review('theatreandtonic.co.uk'),
    target('theatreandtonic.com', { hasSerpKeys: false }), {}).qualifies, true);
});

test('outlet mode still checks outletId even when the URL matches a domain alias', () => {
  assert.equal(evaluateCandidate(review('theatreandtonic.co.uk'),
    target('theatreandtonic.com', { outlet: 'newyorker' }), {}).skipReason, 'wrong_domain');
});
