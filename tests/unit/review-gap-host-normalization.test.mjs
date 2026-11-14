/**
 * Unit tests for registrableHost / hostOf / getKnownDomainMap in
 * scripts/audit-show-review-gap.js
 *
 * Regression for the outlet-registry alias-gap class (card 386637c5): real,
 * already-registered outlets were provisional-onboarded as duplicate outlets
 * because (a) getKnownDomainMap ignored the canonical `domainAliases` field, so
 * huffingtonpost.com (huffpost) and guardian.co.uk (guardian) read as unknown,
 * and (b) hostOf did not collapse mirror/section subdomains, so
 * theater.nytimes.com and amp.theguardian.com missed the known-domain lookup.
 *
 * Run: node --test tests/unit/review-gap-host-normalization.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { registrableHost, hostOf, getKnownDomainMap } = require('../../scripts/audit-show-review-gap.js');

describe('registrableHost — mirror + section subdomain collapse', () => {
  it('strips amp./m./mobile. mirror prefixes', () => {
    assert.strictEqual(registrableHost('amp.theguardian.com'), 'theguardian.com');
    assert.strictEqual(registrableHost('m.nytimes.com'), 'nytimes.com');
    assert.strictEqual(registrableHost('mobile.example.com'), 'example.com');
  });

  it('collapses section subdomains to the registrable domain', () => {
    assert.strictEqual(registrableHost('theater.nytimes.com'), 'nytimes.com');
    assert.strictEqual(registrableHost('www.theater.nytimes.com'), 'nytimes.com');
  });

  it('keeps the 3-label registrable domain for multi-part ccTLDs', () => {
    assert.strictEqual(registrableHost('arts.theguardian.co.uk'), 'theguardian.co.uk');
    assert.strictEqual(registrableHost('theguardian.co.uk'), 'theguardian.co.uk');
  });

  it('leaves blog-platform publication subdomains intact (per-publication identity)', () => {
    assert.strictEqual(registrableHost('pagesonstages.wordpress.com'), 'pagesonstages.wordpress.com');
    assert.strictEqual(registrableHost('newyorknotebook.substack.com'), 'newyorknotebook.substack.com');
  });

  it('is idempotent on a bare registrable domain', () => {
    assert.strictEqual(registrableHost('nytimes.com'), 'nytimes.com');
    assert.strictEqual(registrableHost('www.huffingtonpost.com'), 'huffingtonpost.com');
  });
});

describe('hostOf — normalizes full URLs through registrableHost', () => {
  it('maps a NYT theater-section URL to nytimes.com', () => {
    assert.strictEqual(
      hostOf('https://theater.nytimes.com/2026/06/04/theater/some-review.html'),
      'nytimes.com'
    );
  });
  it('maps an AMP Guardian URL to theguardian.com', () => {
    assert.strictEqual(
      hostOf('https://amp.theguardian.com/stage/2026/jun/04/some-review'),
      'theguardian.com'
    );
  });
});

describe('getKnownDomainMap — domainAliases resolve to the registered outlet', () => {
  const map = getKnownDomainMap();

  it('huffingtonpost.com attributes to huffpost (domainAlias)', () => {
    assert.strictEqual(map.get('huffingtonpost.com'), 'huffpost');
  });
  it('guardian.co.uk attributes to guardian (domainAlias)', () => {
    assert.strictEqual(map.get('guardian.co.uk'), 'guardian');
  });
  it('primary domains still resolve (no regression)', () => {
    assert.strictEqual(map.get('nytimes.com'), 'nytimes');
    assert.strictEqual(map.get('theguardian.com'), 'guardian');
  });

  it('end-to-end: section/mirror/alias hosts all attribute, none stay unknown', () => {
    const cases = [
      ['https://theater.nytimes.com/2026/06/04/theater/x.html', 'nytimes'],
      ['https://amp.theguardian.com/stage/2026/jun/04/x', 'guardian'],
      ['https://www.huffingtonpost.com/entry/x', 'huffpost'],
    ];
    for (const [url, expected] of cases) {
      assert.strictEqual(map.get(hostOf(url)) || null, expected, `${url} → ${expected}`);
    }
  });
});
