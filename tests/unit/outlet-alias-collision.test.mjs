/**
 * Near-duplicate outlet-registry detector (task #1838 / BRO-90).
 *
 * buildRegistryAliasMap()'s text-resolution surface (id, displayName,
 * aliases, and each of those with a leading "the " stripped) is wider than
 * validate-data.js's existing collision checks — a new outlet whose identity
 * lands on another outlet's stripped form is a silent semantic duplicate
 * that steals byline-matched reviews (the-la-times/latimes, BRO-90).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { stripLeadingThe, buildOutletTextKeys, findOutletAliasCollisions } =
  require(resolve(ROOT, 'scripts/lib/outlet-alias-collision.js'));

describe('stripLeadingThe', () => {
  test('strips space-separated "the " prefix', () => {
    assert.strictEqual(stripLeadingThe('the la times'), 'la times');
  });

  test('strips hyphenated "the-" prefix', () => {
    assert.strictEqual(stripLeadingThe('the-la-times'), 'la-times');
  });

  test('leaves text without a "the" prefix untouched', () => {
    assert.strictEqual(stripLeadingThe('la times'), 'la times');
  });

  test('does not strip "the" mid-string', () => {
    assert.strictEqual(stripLeadingThe('theatremania'), 'theatremania');
  });
});

describe('findOutletAliasCollisions', () => {
  test('catches the-la-times as a duplicate of latimes (pre-BRO-90 fixture)', () => {
    // Shaped like the registry BEFORE BRO-90's fix: 'the-la-times' is a
    // separate tier-3 outlet, and 'latimes' does NOT yet list it as an alias.
    const outlets = {
      'the-la-times': { displayName: 'The La Times', tier: 3, aliases: [] },
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: ['la times', 'los angeles times'] },
    };
    const collisions = findOutletAliasCollisions(outlets);
    const ids = new Set(collisions.flatMap((c) => c.outletIds));
    assert.ok(ids.has('the-la-times'), 'the-la-times should be flagged');
    assert.ok(ids.has('latimes'), 'latimes should be flagged');
    const laTimesKeyCollision = collisions.find((c) => c.key === 'la times');
    assert.ok(laTimesKeyCollision, 'expected a collision on the stripped key "la times"');
    assert.deepStrictEqual(laTimesKeyCollision.outletIds, ['latimes', 'the-la-times']);
  });

  test('post-fix registry (the-la-times removed) has no collision', () => {
    const outlets = {
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: ['la times', 'los angeles times', 'the la times'] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('distinct outlets with no shared text produce no collisions', () => {
    const outlets = {
      variety: { displayName: 'Variety', tier: 1, aliases: [] },
      'ny-post': { displayName: 'New York Post', tier: 2, aliases: ['nypost'] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('sentinel outlet ids (e.g. "unknown") are excluded from the scan', () => {
    const outlets = {
      unknown: { displayName: 'Unknown', tier: 3, aliases: [] },
      variety: { displayName: 'Variety', tier: 1, aliases: [] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('_aliasIndex and _meta keys are skipped', () => {
    const outlets = {
      _aliasIndex: { 'la times': 'latimes' },
      _meta: { note: 'x' },
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: [] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('a third outlet squatting on the same stripped key is also flagged', () => {
    const outlets = {
      'the-la-times': { displayName: 'The La Times', tier: 3, aliases: [] },
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: ['la times'] },
      'la-times-blog': { displayName: 'LA Times', tier: 3, aliases: [] },
    };
    const collisions = findOutletAliasCollisions(outlets);
    const laTimesKeyCollision = collisions.find((c) => c.key === 'la times');
    assert.deepStrictEqual(laTimesKeyCollision.outletIds, ['la-times-blog', 'latimes', 'the-la-times']);
  });
});

describe('buildOutletTextKeys', () => {
  test('includes id, displayName, aliases, and their the-stripped forms', () => {
    const keys = buildOutletTextKeys('the-la-times', { displayName: 'The La Times', aliases: ['the-la-times-alt'] });
    assert.ok(keys.includes('the-la-times'));
    assert.ok(keys.includes('la-times'));
    assert.ok(keys.includes('the la times'));
    assert.ok(keys.includes('la times'));
    assert.ok(keys.includes('the-la-times-alt'));
    assert.ok(keys.includes('la-times-alt'));
  });

  test('handles a bare outlet with no displayName/aliases', () => {
    const keys = buildOutletTextKeys('variety', {});
    assert.deepStrictEqual(keys, ['variety']);
  });
});

describe('live registry', () => {
  test('current outlet-registry.json has no unresolved near-duplicates', () => {
    const { readFileSync, existsSync } = require('fs');
    const registryPath = resolve(ROOT, 'data', 'outlet-registry.json');
    if (!existsSync(registryPath)) return; // data not checked out in this environment
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const collisions = findOutletAliasCollisions(registry.outlets || registry);
    assert.deepStrictEqual(
      collisions,
      [],
      `Found ${collisions.length} near-duplicate outlet collision(s): ${JSON.stringify(collisions, null, 2)}`
    );
  });
});
