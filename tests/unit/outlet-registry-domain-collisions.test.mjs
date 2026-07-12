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
const { EDITION_PAIRS, findUndeclaredDomainCollisions } =
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
