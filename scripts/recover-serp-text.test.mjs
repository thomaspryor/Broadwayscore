import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// BRO-141: recover-serp-text.js's urlless --domain candidate gate was
// generalized (task #894 -> #1184) from a Telegraph-only domain-slug hack to
// a real OUTLET_DOMAINS reverse lookup, so ANY outlet's urlless thin-tier
// files become recoverable, not just Telegraph's. The decision logic lives
// in scripts/lib/serp-text-recovery-candidates.js (CLAUDE.md rule 15:
// extract + require(), never re-implement in the test).
const { evaluateCandidate, buildDomainOutletIds, THIN_TIERS } = require('./lib/serp-text-recovery-candidates.js');
const { OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('./lib/url-discovery.js');

function domainOutletIds(domain) {
  return buildDomainOutletIds(domain, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES);
}

function thinFile(overrides = {}) {
  return {
    outletId: 'telegraph',
    contentTier: 'stub',
    ...overrides,
  };
}

test('THIN_TIERS covers exactly truncated/excerpt/stub', () => {
  assert.deepEqual([...THIN_TIERS].sort(), ['excerpt', 'stub', 'truncated']);
});

test('urlless Telegraph candidate qualifies via OUTLET_DOMAINS reverse lookup (original backfill baseline)', () => {
  const data = thinFile({ outletId: 'telegraph' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
  assert.equal(result.skipReason, null);
});

test('generalizes beyond Telegraph: urlless New Yorker candidate qualifies under --domain=newyorker.com', () => {
  const data = thinFile({ outletId: 'newyorker' });
  const target = { domain: 'newyorker.com', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('newyorker.com') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
});

test('generalizes beyond Telegraph: urlless AP candidate qualifies under --domain=apnews.com', () => {
  const data = thinFile({ outletId: 'ap' });
  const target = { domain: 'apnews.com', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('apnews.com') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
});

test('hyphenated outletId matches its domain via reverse lookup, not a naive substring check', () => {
  // hollywood-reporter -> hollywoodreporter.com: outletId does not literally
  // contain "hollywoodreporter" as a contiguous substring across the hyphen,
  // so a bare `outletId.includes(domainSlug)` check (the original Telegraph
  // hack) would have missed this. The OUTLET_DOMAINS reverse lookup does not.
  const data = thinFile({ outletId: 'hollywood-reporter' });
  const target = { domain: 'hollywoodreporter.com', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('hollywoodreporter.com') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
});

test('does not false-positive across similarly-named outlets on different domains (boston-globe vs boston-herald)', () => {
  // Regression guard for the false-positive class called out in
  // scripts/recover-serp-text.js's loadCandidates() comment: a substring
  // match risked boston.com-style collisions across unrelated outlets. The
  // reverse lookup must reject boston-herald when targeting boston-globe's domain.
  const data = thinFile({ outletId: 'boston-herald' });
  const target = { domain: 'bostonglobe.com', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('bostonglobe.com') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'wrong_domain');
});

test('urlless candidate is skipped when no SERP keys are configured (nothing to anchor discovery to)', () => {
  const data = thinFile({ outletId: 'newyorker' });
  const target = { domain: 'newyorker.com', outlet: null, hasSerpKeys: false, domainOutletIds: domainOutletIds('newyorker.com') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'no_url');
});

test('urlless candidate is always skipped in --outlet mode, even with SERP keys', () => {
  // --outlet mode has no per-outlet domain to anchor a fresh SERP search to
  // (it matches data.outletId directly, for wire-service syndication).
  const data = thinFile({ outletId: 'ap' });
  const target = { domain: null, outlet: 'ap', hasSerpKeys: true, domainOutletIds: null };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'no_url');
});

test('--outlet mode with a url matches outletId directly, ignoring domain', () => {
  const data = thinFile({ outletId: 'ap', url: 'https://apnews.com/article/some-review' });
  const target = { domain: null, outlet: 'ap', hasSerpKeys: true, domainOutletIds: null };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
});

test('--outlet mode rejects a mismatched outletId even with a url present', () => {
  const data = thinFile({ outletId: 'newyorker', url: 'https://newyorker.com/culture/review' });
  const target = { domain: null, outlet: 'ap', hasSerpKeys: true, domainOutletIds: null };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'wrong_domain');
});

test('existing-url --domain mode still matches on the url hostname (pre-existing, non-urlless behavior)', () => {
  const data = thinFile({ outletId: 'telegraph', url: 'https://www.telegraph.co.uk/theatre/2026/review' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
});

test('existing-url --domain mode rejects a url hosted on a different domain', () => {
  const data = thinFile({ outletId: 'newyorker', url: 'https://www.newyorker.com/culture/review' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'wrong_domain');
});

test('a malformed url is rejected as bad_url, not treated as urlless', () => {
  const data = thinFile({ outletId: 'telegraph', url: 'not a real url' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'bad_url');
});

test('complete-tier files are excluded regardless of domain match', () => {
  const data = thinFile({ outletId: 'telegraph', contentTier: 'complete' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'complete');
});

test('non-thin, non-complete tiers (e.g. invalid) are excluded without a skip-reason bump', () => {
  const data = thinFile({ outletId: 'telegraph', contentTier: 'invalid' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'not_thin');
});

test('flagged files (wrongShow/wrongProduction/wrongAttribution/isRoundupArticle) are excluded', () => {
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  for (const flag of ['wrongShow', 'wrongProduction', 'wrongAttribution', 'isRoundupArticle']) {
    const data = thinFile({ outletId: 'telegraph', [flag]: true });
    const result = evaluateCandidate(data, target, {});
    assert.equal(result.qualifies, false, `expected ${flag} to exclude`);
    assert.equal(result.skipReason, 'flagged');
  }
});

test('a url already in the exhausted list is excluded', () => {
  const data = thinFile({ outletId: 'telegraph', url: 'https://www.telegraph.co.uk/theatre/2026/review' });
  const target = { domain: 'telegraph.co.uk', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('telegraph.co.uk') };
  const exhausted = { 'https://www.telegraph.co.uk/theatre/2026/review': { reason: 'recovery_exhausted' } };
  const result = evaluateCandidate(data, target, exhausted);
  assert.equal(result.qualifies, false);
  assert.equal(result.skipReason, 'exhausted');
});

test('generalizes to registered domain aliases: urlless AP candidate qualifies under its alias domain abcnews.go.com', () => {
  // AP's registry entry carries domainAliases: ['abcnews.go.com'] (real data).
  // An urlless AP file must still qualify when --domain targets the ALIAS,
  // not just the primary apnews.com — otherwise a URL-bearing AP file on
  // that alias would be recoverable but an otherwise-identical urlless one
  // would report zero candidates (ship-check finding).
  const aliasSet = REGISTRY_DOMAIN_ALIASES['apnews.com'];
  assert.ok(aliasSet && aliasSet.has('abcnews.go.com'), 'expected AP domain alias fixture to still be registered');
  const data = thinFile({ outletId: 'ap' });
  const target = { domain: 'abcnews.go.com', outlet: null, hasSerpKeys: true, domainOutletIds: domainOutletIds('abcnews.go.com') };
  const result = evaluateCandidate(data, target, {});
  assert.equal(result.qualifies, true);
});

test('buildDomainOutletIds returns an empty set for a domain with no outlets and no aliases', () => {
  const result = buildDomainOutletIds('not-a-real-domain.example', OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES);
  assert.equal(result.size, 0);
});

test('buildDomainOutletIds returns an empty set for a null/undefined domain', () => {
  assert.equal(buildDomainOutletIds(null, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES).size, 0);
  assert.equal(buildDomainOutletIds(undefined, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES).size, 0);
});

test('OUTLET_DOMAINS carries multiple outlets beyond Telegraph (sanity check the generalization has real data to work with)', () => {
  // Guards the whole test file against a registry regression collapsing to a
  // single outlet, which would make every "generalizes beyond Telegraph"
  // test above vacuously pass on missing data instead of real coverage.
  const distinctDomains = new Set(Object.values(OUTLET_DOMAINS));
  assert.ok(distinctDomains.size > 50, `expected many distinct outlet domains, found ${distinctDomains.size}`);
  assert.ok(OUTLET_DOMAINS['telegraph'], 'telegraph should still resolve');
  assert.ok(OUTLET_DOMAINS['newyorker'], 'newyorker should resolve');
});
