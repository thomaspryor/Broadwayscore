/**
 * Guards scraper.js `domainMatchesExpected`'s registry-alias branch, which
 * decides whether a URL's host is an acceptable match for an outlet's
 * expected domain — used by the automated discovery pipeline's SERP host
 * gate (url-discovery.js) and by fetchPage's URL-mismatch verification.
 *
 * Root cause (issue #908, 2026-09-22): a real Daily Mail review published at
 * newspaper.dailymail.com — a subdomain of the registered domainAlias
 * dailymail.com, not dailymail.com itself — was silently dropped by this
 * gate. The registry-alias branch only checked exact Set membership
 * (`regAliases.has(actualDomain)`), so a subdomain of a registered alias
 * never matched even though a subdomain of the PRIMARY domain already did
 * (the branch just above it). This test freezes the fix: alias matching is
 * now suffix-aware in both directions, symmetric with the primary-domain
 * subdomain check that already existed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { domainMatchesExpected, setRegistryDomainAliases, verifyFetchedUrl } = require('../../scripts/lib/scraper.js');

describe('domainMatchesExpected primary domain boundaries (BRO-5328)', () => {
  for (const [expected, actual] of [
    ['nytimes.com', 'nytimes.com'],
    ['nytimes.com', 'amp.nytimes.com'],
    ['amp.nytimes.com', 'nytimes.com'],
    ['nytimes.com', 'archive.amp.nytimes.com'],
    ['vulture.com', 'nymag.com'],
    ['nymag.com', 'vulture.com'],
    ['variety.com', 'deadline.com'],
  ]) {
    test(`preserves legitimate match: ${expected} / ${actual}`, () => {
      assert.equal(domainMatchesExpected(expected, actual), true);
    });
  }

  for (const [expected, actual] of [
    ['nytimes.com', 'times.com'],
    ['variety.com', 'myvariety.com.example'],
    ['nymag.com', 'nymag.com.evil'],
    ['vulture.com', 'notvulture.com'],
  ]) {
    test(`rejects look-alikes in both directions: ${expected} / ${actual}`, () => {
      assert.equal(domainMatchesExpected(expected, actual), false);
      assert.equal(domainMatchesExpected(actual, expected), false);
    });

    test(`rejects a fetched canonical on look-alike host: ${actual}`, () => {
      const html = `<html><head><link rel="canonical" href="https://${actual}/review"></head></html>`;
      const result = verifyFetchedUrl(html, `https://${expected}/review`);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });
  }
});

describe('domainMatchesExpected — registry alias subdomain matching', () => {
  test('matches a subdomain of a registered alias domain (Daily Mail e-edition)', () => {
    setRegistryDomainAliases({
      'dailymail.co.uk': new Set(['dailymail.com']),
      'dailymail.com': new Set(['dailymail.co.uk']),
    });
    assert.equal(domainMatchesExpected('dailymail.co.uk', 'newspaper.dailymail.com'), true);
  });

  test('still matches the alias domain itself, unchanged', () => {
    setRegistryDomainAliases({
      'dailymail.co.uk': new Set(['dailymail.com']),
      'dailymail.com': new Set(['dailymail.co.uk']),
    });
    assert.equal(domainMatchesExpected('dailymail.co.uk', 'dailymail.com'), true);
  });

  test('matches when the EXPECTED domain is a subdomain of a registered alias (reverse direction)', () => {
    setRegistryDomainAliases({
      'oneminutecritic.com': new Set(['1minutecritic.com']),
      '1minutecritic.com': new Set(['oneminutecritic.com']),
    });
    assert.equal(domainMatchesExpected('archive.oneminutecritic.com', '1minutecritic.com'), true);
  });

  test('does not match an unrelated domain that merely shares a substring with an alias', () => {
    setRegistryDomainAliases({
      'dailymail.co.uk': new Set(['dailymail.com']),
      'dailymail.com': new Set(['dailymail.co.uk']),
    });
    assert.equal(domainMatchesExpected('dailymail.co.uk', 'notdailymail.com'), false);
  });

  test('returns false with no registry aliases loaded (fail-safe)', () => {
    setRegistryDomainAliases(null);
    assert.equal(domainMatchesExpected('dailymail.co.uk', 'newspaper.dailymail.com'), false);
  });
});
