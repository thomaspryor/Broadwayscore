/**
 * Unit tests for scripts/lib/critic-alias-picker.js — audit S7-T5 (BRO-4204).
 *
 * The weekly typo picker (scripts/detect-critic-typos.js) chose "the slug
 * with more files" and wrote it as a new key of data/auto-critic-aliases.json
 * even when that slug was already an alias of another canonical; the file
 * accumulated 15 alias strings claimed by two keys and 9 keys that were
 * themselves typos. The picker rule is required from the real module (§15)
 * and exercised with fixtures; the last test pins the cleaned real file.
 *
 * Run: node --test tests/unit/critic-alias-picker.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildAliasIndex,
  resolveCanonical,
  digitsOnlyDifference,
  buildRegistrySpellings,
  buildOutletSlugs,
  pickCanonical,
  findAliasHome,
  recordAlias,
} = require('../../scripts/lib/critic-alias-picker.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A poisoned table in the shape the real file had before the cleanup.
const TABLE = {
  'alexis-soloski': ['alexis soloski', 'alex soloski', 'alexsis soloski', 'alesis soloski'],
  'sarah-hemming': ['sarah hemming', 'sarahhemming', 'sara hemming'],
  'sara-hemming': ['sara hemming', 'sarahhemming'], // key that is itself an alias of sarah-hemming
  'jd-knapp': ['jd knapp', 'j.d. knapp'],
};

test('buildAliasIndex: a key that is an alias of another key resolves to that key', () => {
  const index = buildAliasIndex(TABLE);
  assert.equal(index.idx.get('jd-knapp'), 'jd-knapp');
  assert.equal(index.idx.get('alesis-soloski'), 'alexis-soloski');
  assert.equal(resolveCanonical('sara-hemming', index).canonical, 'sarah-hemming');
  assert.equal(resolveCanonical('sarahhemming', index).canonical, 'sarah-hemming');
  assert.deepEqual(resolveCanonical('nobody-here', index), { known: false, canonical: null, ambiguous: false });
  assert.equal(index.conflicts.size, 0);
});

test('buildAliasIndex: an alias under two different canonicals is a conflict, and the picker refuses it', () => {
  const index = buildAliasIndex({
    'bill-hagerty': ['bill hagerty', 'billhagerty'],
    'biilhagerty': ['biilhagerty', 'billhagerty'],
  });
  assert.ok(index.conflicts.has('billhagerty'));
  assert.equal(resolveCanonical('billhagerty', index).ambiguous, true);
  const pick = pickCanonical({ a: 'billhagerty', b: 'billhagerry', countA: 9, countB: 1, aliasIndex: index });
  assert.equal(pick.skip, true);
  assert.match(pick.reason, /two canonicals/);
});

test('never chooses a canonical that is itself an alias elsewhere, whatever the file counts say', () => {
  const index = buildAliasIndex(TABLE);
  // "alesis-soloski" has more files than the new typo, but it is an alias of alexis-soloski.
  const pick = pickCanonical({ a: 'alesis-soloski', b: 'alesis-soloskl', countA: 20, countB: 1, aliasIndex: index });
  assert.equal(pick.skip, false);
  assert.equal(pick.canonical, 'alexis-soloski');
  assert.equal(pick.typo, 'alesis-soloskl');
  // A poisoned key resolves through to its real canonical.
  const pick2 = pickCanonical({ a: 'sara-heming', b: 'sara-hemming', countA: 1, countB: 8, aliasIndex: index });
  assert.equal(pick2.canonical, 'sarah-hemming');
  assert.equal(pick2.typo, 'sara-heming');
  // An existing canonical stays canonical even with fewer files.
  const pick3 = pickCanonical({ a: 'jd-knap', b: 'jd-knapp', countA: 50, countB: 2, aliasIndex: index });
  assert.equal(pick3.canonical, 'jd-knapp');
  assert.equal(pick3.typo, 'jd-knap');
});

test('a pair already aliased together is a silent skip; two different known canonicals go to a human', () => {
  const index = buildAliasIndex(TABLE);
  const same = pickCanonical({ a: 'alesis-soloski', b: 'alexis-soloski', countA: 1, countB: 50, aliasIndex: index });
  assert.equal(same.skip, true);
  assert.equal(same.silent, true);
  const diff = pickCanonical({ a: 'jd-knapp', b: 'jd-knapp-', countA: 1, countB: 1, aliasIndex: buildAliasIndex({ ...TABLE, 'jd-knapp-': ['jd knapp-'] }) });
  assert.equal(diff.skip, true);
  assert.equal(diff.silent, undefined);
  assert.match(diff.reason, /different canonicals/);
});

test('prefers the registry spelling over the file count', () => {
  const index = buildAliasIndex(TABLE);
  const registrySpellings = buildRegistrySpellings({
    outletRegistry: { outlets: { 'london-theatre': { defaultCritic: 'Cheryl Markosky' } } },
    criticRegistry: { critics: { 'lyn-gardner': {} } },
  });
  assert.ok(registrySpellings.has('cheryl-markosky'));
  assert.ok(registrySpellings.has('lyn-gardner'));
  const pick = pickCanonical({ a: 'cheryl-markoski', b: 'cheryl-markosky', countA: 5, countB: 1, aliasIndex: index, registrySpellings });
  assert.equal(pick.canonical, 'cheryl-markosky');
  assert.equal(pick.typo, 'cheryl-markoski');
  assert.match(pick.reason, /registry spelling/);
  // Both or neither in the registry → fall back to file count; ties keep the first (sorted) slug.
  const byCount = pickCanonical({ a: 'ann-treneman', b: 'anne-treneman', countA: 3, countB: 7, aliasIndex: index, registrySpellings });
  assert.equal(byCount.canonical, 'anne-treneman');
  const tie = pickCanonical({ a: 'ann-treneman', b: 'anne-treneman', countA: 3, countB: 3, aliasIndex: index, registrySpellings });
  assert.equal(tie.canonical, 'ann-treneman');
});

test('a digit-only difference (year/edition suffix) is never a typo', () => {
  assert.equal(digitsOnlyDifference('helen-shaw-2024-bway', 'helen-shaw-2025-bway'), true);
  assert.equal(digitsOnlyDifference('ann-treneman', 'anne-treneman'), false);
  const pick = pickCanonical({ a: 'helen-shaw-2024-bway', b: 'helen-shaw-2025-bway', countA: 3, countB: 2, aliasIndex: buildAliasIndex({}) });
  assert.equal(pick.skip, true);
  assert.match(pick.reason, /digit/);
});

test('an outlet name is never chosen as a critic', () => {
  const outletSlugs = buildOutletSlugs({ outlets: { thestage: { displayName: 'The Stage' }, 'all-that-dazzles-uk': { displayName: 'All That Dazzles  (UK)' } } });
  assert.ok(outletSlugs.has('the-stage'));
  assert.ok(outletSlugs.has('thestage'));
  assert.ok(outletSlugs.has('all-that-dazzles'));
  const pick = pickCanonical({ a: 'the-stage', b: 'thestage', countA: 4, countB: 2, aliasIndex: buildAliasIndex({}), outletSlugs });
  assert.equal(pick.skip, true);
  assert.match(pick.reason, /outlet name/);
});

test('recordAlias never creates a key that is an alias of another key, and never re-claims a typo', () => {
  const aliases = {
    'sarah-hemming': ['sarah hemming', 'sara hemming'],
    'alexis-soloski': ['alexis soloski', 'alesis soloski'],
  };
  // Routed to the home key of the would-be canonical.
  const r1 = recordAlias(aliases, 'sara-hemming', 'sara-heming');
  assert.deepEqual(r1, { added: true, target: 'sarah-hemming' });
  assert.ok(!aliases['sara-hemming']);
  assert.ok(aliases['sarah-hemming'].includes('sara heming'));
  // A typo string another key already owns is refused.
  const r2 = recordAlias(aliases, 'sarah-hemming', 'alesis-soloski');
  assert.equal(r2.added, false);
  assert.match(r2.reason, /already an alias of alexis-soloski/);
  // A typo that is itself a canonical key is refused.
  const r3 = recordAlias(aliases, 'sarah-hemming', 'alexis-soloski');
  assert.equal(r3.added, false);
  assert.match(r3.reason, /canonical key/);
  // Idempotent.
  const r4 = recordAlias(aliases, 'sarah-hemming', 'sara-heming');
  assert.equal(r4.added, false);
  assert.equal(r4.reason, 'already present');
  // A brand-new canonical gets its own spelled-out first alias, as before.
  const r5 = recordAlias(aliases, 'tom-wicker', 'tim-wicker');
  assert.deepEqual(r5, { added: true, target: 'tom-wicker' });
  assert.deepEqual(aliases['tom-wicker'], ['tom wicker', 'tim wicker']);
  assert.equal(findAliasHome(aliases, 'tim-wicker'), 'tom-wicker');
});

test('detect-critic-typos.js is wired to the picker (no inline count-only rule)', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/detect-critic-typos.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/critic-alias-picker'\)/);
  assert.match(src, /pickCanonical\(/);
  assert.match(src, /recordAlias\(/);
  assert.doesNotMatch(src, /countA >= countB \? a : b/);
});

test('the cleaned data/auto-critic-aliases.json has no conflicts, no typo canonicals, no outlet names', () => {
  const file = JSON.parse(readFileSync(path.join(repoRoot, 'data/auto-critic-aliases.json'), 'utf8'));
  const index = buildAliasIndex(file.aliases);
  assert.equal(index.conflicts.size, 0, `conflicting aliases: ${[...index.conflicts.keys()].join(', ')}`);
  for (const key of Object.keys(file.aliases)) {
    assert.equal(index.idx.get(key), key, `${key} is an alias of ${index.idx.get(key)}`);
    assert.ok(!/\d/.test(key), `${key} carries a digit (year suffix)`);
  }
  const { loadOutletRegistry, CRITIC_ALIASES } = require('../../scripts/lib/review-normalization.js');
  const outletSlugs = buildOutletSlugs(loadOutletRegistry());
  for (const key of Object.keys(file.aliases)) {
    assert.ok(!outletSlugs.has(key), `${key} is an outlet name`);
  }
  // And the merged runtime table (built-ins + auto file) is conflict-free too.
  assert.equal(buildAliasIndex(CRITIC_ALIASES).conflicts.size, 0);
});
