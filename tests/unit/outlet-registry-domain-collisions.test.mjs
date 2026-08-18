/**
 * Primary-domain collision gate (card 39b637c5-416f-81db).
 *
 * >1 outlet sharing a primary domain makes URL-based outlet resolution
 * ambiguous — the resolver picks one winner and the loser can never be
 * identified from a URL (telegraph.co.uk → sunday-telegraph mis-homed 161
 * reviews at T3). Only declared EDITION_PAIRS may share a domain.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { EDITION_PAIRS, DECLARED_ALIAS_OVERLAPS, findUndeclaredDomainCollisions, wouldCauseDomainCollision } =
  require(resolve(ROOT, 'scripts/lib/outlet-registry-domain-collisions.js'));

describe('findUndeclaredDomainCollisions', () => {
  test('flags two outlets sharing an undeclared primary domain', () => {
    const collisions = findUndeclaredDomainCollisions({
      'some-blog': { domain: 'someblog.com' },
      'some-blog-2': { domain: 'someblog.com' },
      'other': { domain: 'other.com' },
    });
    assert.deepStrictEqual(collisions, [
      { domain: 'someblog.com', outletIds: ['some-blog', 'some-blog-2'] },
    ]);
  });

  test('declared edition pairs pass', () => {
    const collisions = findUndeclaredDomainCollisions({
      telegraph: { domain: 'telegraph.co.uk' },
      'sunday-telegraph': { domain: 'telegraph.co.uk' },
      'express-uk': { domain: 'express.co.uk' },
      'sunday-express': { domain: 'express.co.uk' },
      timeout: { domain: 'timeout.com' },
      'timeout-london': { domain: 'timeout.com' },
    });
    assert.deepStrictEqual(collisions, []);
  });

  test('a third outlet squatting on a declared-pair domain still fails', () => {
    const collisions = findUndeclaredDomainCollisions({
      telegraph: { domain: 'telegraph.co.uk' },
      'sunday-telegraph': { domain: 'telegraph.co.uk' },
      'telegraph-squatter': { domain: 'telegraph.co.uk' },
    });
    assert.strictEqual(collisions.length, 1);
    assert.deepStrictEqual(collisions[0].outletIds,
      ['sunday-telegraph', 'telegraph', 'telegraph-squatter']);
  });

  test('www prefix and case are normalized before grouping', () => {
    const collisions = findUndeclaredDomainCollisions({
      a: { domain: 'www.SomeBlog.com' },
      b: { domain: 'someblog.com' },
    });
    assert.strictEqual(collisions.length, 1);
    assert.strictEqual(collisions[0].domain, 'someblog.com');
  });

  test('outlets without a domain are ignored', () => {
    assert.deepStrictEqual(findUndeclaredDomainCollisions({
      a: { displayName: 'No Domain' },
      b: { domain: '' },
      c: { domain: 'unique.com' },
    }), []);
  });

  test('EDITION_PAIRS is exactly the three known masthead splits', () => {
    assert.deepStrictEqual(EDITION_PAIRS.map((p) => [...p].sort()), [
      ['sunday-telegraph', 'telegraph'],
      ['express-uk', 'sunday-express'],
      ['timeout', 'timeout-london'],
    ]);
  });

  test('flags an outlet whose domainAliases claims another outlet\'s primary domain (task #1270)', () => {
    const collisions = findUndeclaredDomainCollisions({
      'real-outlet': { domain: 'realoutlet.com' },
      'squatter': { domain: 'squatter.com', domainAliases: ['realoutlet.com'] },
    });
    assert.deepStrictEqual(collisions, [
      { domain: 'realoutlet.com', outletIds: ['real-outlet', 'squatter'] },
    ]);
  });

  test('two outlets whose domainAliases both claim the same third host still collide', () => {
    const collisions = findUndeclaredDomainCollisions({
      a: { domain: 'a.com', domainAliases: ['shared.com'] },
      b: { domain: 'b.com', domainAliases: ['shared.com'] },
    });
    assert.deepStrictEqual(collisions, [
      { domain: 'shared.com', outletIds: ['a', 'b'] },
    ]);
  });

  test('an outlet is not flagged against itself when its own domain equals its own domainAlias', () => {
    assert.deepStrictEqual(findUndeclaredDomainCollisions({
      a: { domain: 'a.com', domainAliases: ['a.com', 'www.a.com'] },
    }), []);
  });

  test('DECLARED_ALIAS_OVERLAPS pairs are covered (domainAliases-only collisions)', () => {
    const collisions = findUndeclaredDomainCollisions({
      ap: { domain: 'apnews.com', domainAliases: ['abcnews.go.com'] },
      'abc-news': { domain: 'abcnews.go.com' },
    });
    assert.deepStrictEqual(collisions, []);
  });

  test('DECLARED_ALIAS_OVERLAPS is exactly the four known domain/domainAlias overlaps', () => {
    assert.deepStrictEqual(DECLARED_ALIAS_OVERLAPS.map((p) => [...p].sort()), [
      ['abc-news', 'ap'],
      ['bobs-theater-blog', 'gotham-playgoer'],
      ['dc-metro-theater-arts', 'dctheatrescene'],
      ['chicago-sun-times', 'suntimes'],
    ]);
  });
});

describe('wouldCauseDomainCollision', () => {
  test('flags a candidate whose inferred domain is already claimed (task #1776)', () => {
    assert.strictEqual(
      wouldCauseDomainCollision({ 'times-uk': { domain: 'thetimes.co.uk' } }, 'the-times-barbican', 'thetimes.co.uk'),
      true
    );
  });

  test('allows a candidate whose domain is unclaimed', () => {
    assert.strictEqual(
      wouldCauseDomainCollision({ 'times-uk': { domain: 'thetimes.co.uk' } }, 'some-new-outlet', 'someblog.com'),
      false
    );
  });

  test('does not flag a candidate with no domain', () => {
    assert.strictEqual(
      wouldCauseDomainCollision({ 'times-uk': { domain: 'thetimes.co.uk' } }, 'the-times-barbican', null),
      false
    );
  });

  test('a candidate joining a declared EDITION_PAIRS domain is not flagged', () => {
    assert.strictEqual(
      wouldCauseDomainCollision({ timeout: { domain: 'timeout.com' } }, 'timeout-london', 'timeout.com'),
      false
    );
  });

  test('flags a candidate whose primary domain is claimed by an existing outlet only via domainAliases (task #1270 pattern)', () => {
    assert.strictEqual(
      wouldCauseDomainCollision(
        { squatter: { domain: 'squatter.com', domainAliases: ['thetimes.co.uk'] } },
        'the-times-barbican',
        'thetimes.co.uk'
      ),
      true
    );
  });

  test('an empty registry never collides', () => {
    assert.strictEqual(wouldCauseDomainCollision({}, 'the-times-barbican', 'thetimes.co.uk'), false);
  });
});

describe('current registry', () => {
  test('data/outlet-registry.json has no undeclared primary-domain collisions', () => {
    const registry = JSON.parse(readFileSync(resolve(ROOT, 'data/outlet-registry.json'), 'utf8'));
    const collisions = findUndeclaredDomainCollisions(registry.outlets || registry);
    assert.deepStrictEqual(collisions, [],
      `undeclared collisions: ${JSON.stringify(collisions)} — merge the duplicates, fix the domain, or declare the pair in EDITION_PAIRS`);
  });
});

describe('validate-data wiring', () => {
  test('validate-data.js calls the collision gate', () => {
    const contents = readFileSync(resolve(ROOT, 'scripts/validate-data.js'), 'utf8');
    assert.match(contents, /require\(['"]\.\/lib\/outlet-registry-domain-collisions['"]\)/,
      'validate-data.js must import the collision gate');
    const calls = contents.match(/validateOutletRegistryDomainCollisions\(\)/g) || [];
    assert.ok(calls.length >= 1, 'validateOutletRegistryDomainCollisions() must be called in the main flow');
  });
});
