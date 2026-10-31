// BRO-4419: content-farm look-alike hosts must never be accepted as the outlet they imitate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const registry = require('../../data/outlet-registry.json');
const { findLookalikeHost, isLookalikeContentFarmUrl, hostLabel, editDistance, LOOKALIKE_CONTENT_FARM_DOMAINS } = require('./outlet-lookalike-guard.js');
const { isBlockedReviewUrl, isBlockedDomain, CENSUS_JUNK_DOMAINS } = require('./domain-filters.js');
const { normalizeOutlet } = require('./review-normalization.js');
const { classifyReviewUrl } = require('./non-review-url-patterns.js');

const NYSE = 'https://nysepost.com/broadways-king-charles-iii-ingenuous-intriguing-33177';

test('nysepost.com is refused as nypost (detector, blocklist, alias)', () => {
  const d = findLookalikeHost('nypost', NYSE, registry);
  assert.equal(d.lookalike, true);
  assert.equal(d.imitates, 'nypost.com');
  assert.equal(isLookalikeContentFarmUrl(NYSE), true);
  assert.equal(isBlockedReviewUrl(NYSE), true);
  assert.notEqual(normalizeOutlet('nysepost'), 'nypost', 'nysepost must not be an alias of nypost');
});

test('guardianlv.com is refused as guardian', () => {
  const u = 'http://guardianlv.com/2016/07/stars-make-grey-gardens-heart-wrenching-musical-worth-seeing-review/';
  assert.equal(findLookalikeHost('guardian', u, registry).lookalike, true);
  assert.equal(isBlockedReviewUrl(u), true);
});

test('detector: brand-new imitator is caught without being listed', () => {
  assert.equal(findLookalikeHost('nypost', 'https://nypostt.com/x', registry).lookalike, true);
  assert.equal(findLookalikeHost('nytimes', 'https://nytimez.com/x', registry).lookalike, true);
});

test('detector: real domains, subdomains and unrelated real outlets pass', () => {
  assert.equal(findLookalikeHost('nypost', 'https://nypost.com/2015/x', registry).lookalike, false);
  assert.equal(findLookalikeHost('nypost', 'https://www.nypost.com/x', registry).lookalike, false);
  assert.equal(findLookalikeHost('nytimes', 'https://www.nytimes.com/x', registry).lookalike, false);
  // different real outlet, near-identical label: scoped to the row's own outlet, but not owned -> only the
  // same-outlet imitation counts. gaytimes vs nytimes differ by 2 edits; it is only flagged if filed AS nytimes.
  assert.equal(findLookalikeHost('gay-times', 'https://gaytimes.com/x', registry).lookalike, false);
  assert.equal(findLookalikeHost('unknown-outlet', 'https://nysepost.com/x', registry).lookalike, false);
  assert.equal(findLookalikeHost('nypost', 'not a url', registry).lookalike, false);
});

test('helpers', () => {
  assert.equal(hostLabel('www.guardian.co.uk'), 'guardian');
  assert.equal(hostLabel('nypost.com'), 'nypost');
  assert.equal(editDistance('nypost', 'nysepost'), 2);
});

test('census junk hosts: blocked on write path AND discovery path, and no real outlet is caught', () => {
  assert.ok(CENSUS_JUNK_DOMAINS.size > 40);
  for (const d of [...CENSUS_JUNK_DOMAINS, ...LOOKALIKE_CONTENT_FARM_DOMAINS]) {
    const u = `https://${d}/some/page`;
    assert.equal(isBlockedReviewUrl(u), true, `${d} write path`);
    assert.equal(isBlockedDomain(d), true, `${d} isBlockedDomain`);
    assert.equal(classifyReviewUrl(u).ok, false, `${d} discovery path`);
  }
  // a registered outlet's domain is never on either list
  for (const [id, o] of Object.entries(registry.outlets)) {
    if (!o.domain) continue;
    assert.ok(!CENSUS_JUNK_DOMAINS.has(o.domain) && !LOOKALIKE_CONTENT_FARM_DOMAINS.has(o.domain), `registered outlet ${id} (${o.domain}) is on a junk list`);
  }
});

test('the 5 provisional outlets are decided (registered, alias-resolvable)', () => {
  const expect = { burnhamdramaturgy: 'burnham-dramaturgy', stageraw: 'stage-raw', larchmontbuzz: 'larchmont-buzz', theatrevillage: 'theatre-village', classicalsource: 'classical-source' };
  for (const [prov, canon] of Object.entries(expect)) {
    assert.equal(normalizeOutlet(prov), canon, prov);
    assert.ok(registry.outlets[canon].domain, `${canon} has a domain`);
  }
});
