/**
 * Unit tests for buildSiteClause (scripts/lib/url-discovery.js).
 *
 * Per-outlet SERP discovery used `site:<primaryDomain>` only, ignoring the
 * registry's domainAliases. Outlets that publish on an alias TLD were silently
 * missed (A Life in Four Seasons 2026-06-16: theatreandtonic.com primary but the
 * review lives on theatreandtonic.co.uk; londontheatrereviews.co.uk primary but
 * the review lives on londontheatre.co.uk). The fix expands the site: clause to
 * cover all known domains: `(site:a OR site:b)`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildSiteClause, REGISTRY_DOMAIN_ALIASES } = require('../../scripts/lib/url-discovery.js');

describe('buildSiteClause — alias expansion', () => {
  test('single-domain (no aliases) returns plain site: clause', () => {
    assert.strictEqual(buildSiteClause('playstosee.com', new Set()), 'site:playstosee.com');
  });

  test('domain with aliases returns an OR-group covering all domains', () => {
    const r = buildSiteClause('theatreandtonic.com', new Set(['theatreandtonic.co.uk']));
    assert.strictEqual(r, '(site:theatreandtonic.com OR site:theatreandtonic.co.uk)');
  });

  test('multiple aliases all included, primary first', () => {
    const r = buildSiteClause('a.com', new Set(['b.com', 'c.com']));
    assert.ok(r.startsWith('(site:a.com OR '));
    assert.ok(r.includes('site:b.com'));
    assert.ok(r.includes('site:c.com'));
  });

  test('empty domain returns empty string (no crash)', () => {
    assert.strictEqual(buildSiteClause(''), '');
    assert.strictEqual(buildSiteClause(null), '');
  });

  test('accepts array aliasOverride as well as Set', () => {
    assert.strictEqual(
      buildSiteClause('a.com', ['b.com']),
      '(site:a.com OR site:b.com)'
    );
  });

  // Hardening (ship-check 2026-06-16): malformed/duplicate aliases must not
  // produce malformed Google queries.
  test('alias equal to primary is deduped (no "(site:a OR site:a)")', () => {
    assert.strictEqual(buildSiteClause('a.com', ['a.com']), 'site:a.com');
  });
  test('whitespace-containing alias is dropped (no "site:foo bar")', () => {
    assert.strictEqual(buildSiteClause('a.com', ['b c.com']), 'site:a.com');
  });
  test('empty-string alias is dropped', () => {
    assert.strictEqual(buildSiteClause('a.com', ['', 'b.com']), '(site:a.com OR site:b.com)');
  });
  test('whitespace primary domain returns empty (no "site:foo bar")', () => {
    assert.strictEqual(buildSiteClause('foo bar'), '');
  });

  describe('against the real registry (regression for the 2026-06-16 misses)', () => {
    test('theatreandtonic.com expands to include theatreandtonic.co.uk', () => {
      const r = buildSiteClause('theatreandtonic.com');
      assert.ok(r.includes('site:theatreandtonic.co.uk'), `got: ${r}`);
    });

    test('londontheatrereviews.co.uk expands to include londontheatre.co.uk', () => {
      // Only assert if the registry still carries this alias pairing.
      if (REGISTRY_DOMAIN_ALIASES['londontheatrereviews.co.uk']) {
        const r = buildSiteClause('londontheatrereviews.co.uk');
        assert.ok(r.includes('site:londontheatre.co.uk'), `got: ${r}`);
      }
    });
  });
});
