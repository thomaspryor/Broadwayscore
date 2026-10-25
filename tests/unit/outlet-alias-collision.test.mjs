/**
 * Near-duplicate outlet-registry detector (task #1838 / BRO-90; extended to
 * the slugify()/concatenated class by task #1844).
 *
 * buildRegistryAliasMap()'s text-resolution surface (id, displayName,
 * aliases, and each of those with a leading "the " stripped) is wider than
 * validate-data.js's existing collision checks — a new outlet whose identity
 * lands on another outlet's stripped form is a silent semantic duplicate
 * that steals byline-matched reviews (the-la-times/latimes, BRO-90). Task
 * #1844 extends this to a hyphenated masthead and its concatenated
 * (no-hyphen) sibling registering as two separate outlets
 * (theater-news-online/theaternewsonline).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { stripLeadingThe, buildOutletTextKeys, findOutletAliasCollisions, wouldCauseAliasCollision } =
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

  test('a new outlet colliding with a DIFFERENT outlet\'s _aliasIndex entry is flagged', () => {
    // _aliasIndex is a second, independent resolution source
    // (review-normalization.js:104-111) — a new outlet's own identity can
    // collide with an _aliasIndex alias that points at someone else entirely,
    // not just with another outlet's own `aliases` array. Registered as its
    // own id (the realistic collision surface — ids and _aliasIndex keys are
    // both slug/hyphenated text, unlike free-text displayNames).
    const outlets = {
      'the-globe-and-mail': { displayName: 'The Globe and Mail', tier: 3, aliases: [] },
      'the-globe-and-mail-j-kelly-nestruck': { displayName: 'J Kelly Nestruck Blog', tier: 3, aliases: [] },
    };
    const aliasIndex = { 'the-globe-and-mail-j-kelly-nestruck': 'the-globe-and-mail' };
    const collisions = findOutletAliasCollisions(outlets, aliasIndex);
    const hit = collisions.find((c) => c.key === 'the-globe-and-mail-j-kelly-nestruck');
    assert.ok(hit, 'expected a collision on the aliasIndex-claimed key');
    assert.deepStrictEqual(hit.outletIds, ['the-globe-and-mail', 'the-globe-and-mail-j-kelly-nestruck']);
  });

  test('_aliasIndex entries pointing at the SAME outlet as the collision do not false-positive', () => {
    const outlets = {
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: ['la times'] },
    };
    const aliasIndex = { 'the-la-times-charles-mcnulty': 'latimes' };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets, aliasIndex), []);
  });

  test('omitting aliasIndex entirely does not throw and behaves as empty', () => {
    const outlets = { variety: { displayName: 'Variety', tier: 1, aliases: [] } };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets, undefined), []);
  });
});

describe('findOutletAliasCollisions — hyphen/concatenated class (task #1844)', () => {
  // Fixtures shaped like the live registry BEFORE task #1844's merge: each
  // pair is a hyphenated masthead registration and a separately-created
  // concatenated (no-hyphen) registration of the SAME real outlet.
  const HYPHEN_CONCAT_FIXTURES = [
    ['theater-news-online', 'theaternewsonline', { displayName: 'Theater News Online' }, { displayName: 'Theaternewsonline' }],
    ['new-city-stage', 'newcitystage', { displayName: 'New City Stage' }, { displayName: 'newcitystage' }],
    ['dallas-voice', 'dallasvoice', { displayName: 'Dallas Voice' }, { displayName: 'Dallasvoice' }],
    ['the-only-critic', 'theonlycritic', { displayName: 'The Only Critic' }, { displayName: 'Theonlycritic' }],
    ['adrian-dim-anlig', 'adriandimanlig', { displayName: 'Adrian Dim Anlig' }, { displayName: 'Adriandimanlig' }],
    ['new-york-city-theatre', 'newyorkcitytheatre', { displayName: 'New York City Theatre' }, { displayName: 'Newyorkcitytheatre' }],
    ['out-in-jersey', 'outinjersey', { displayName: 'Out In Jersey' }, { displayName: 'Outinjersey' }],
  ];

  for (const [hyphenId, concatId, hyphenEntry, concatEntry] of HYPHEN_CONCAT_FIXTURES) {
    test(`catches ${hyphenId} as a duplicate of ${concatId} (pre-#1844 fixture)`, () => {
      const outlets = {
        [hyphenId]: { tier: 3, aliases: [], ...hyphenEntry },
        [concatId]: { tier: 3, aliases: [], ...concatEntry },
      };
      const collisions = findOutletAliasCollisions(outlets);
      const ids = new Set(collisions.flatMap((c) => c.outletIds));
      assert.ok(ids.has(hyphenId), `${hyphenId} should be flagged`);
      assert.ok(ids.has(concatId), `${concatId} should be flagged`);
      const hit = collisions.find((c) => c.key === concatId.toLowerCase());
      assert.ok(hit, `expected a collision on the concatenated key "${concatId}"`);
    });
  }

  test('post-merge registry (concatenated phantom removed) has no collision', () => {
    const outlets = {
      'theater-news-online': {
        displayName: 'Theater News Online', tier: 3,
        aliases: ['theaternewsonline', 'theaternewsonline.com'],
      },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('hyphenated id and concatenated id for genuinely different outlets do not collide', () => {
    const outlets = {
      'new-york-times': { displayName: 'The New York Times', tier: 1, aliases: [] },
      'nypost': { displayName: 'New York Post', tier: 2, aliases: [] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('express-uk and sunday-express (distinct UK masthead editions sharing a domain) do not collide once the misplaced alias is fixed', () => {
    // Pre-#1844-follow-up shape had 'sundayexpress' on express-uk, which
    // collided with sunday-express (a real routing bug, not a registry
    // duplicate — fixed by moving the alias, not by merging the outlets).
    const outlets = {
      'express-uk': { displayName: 'Express  (UK)', tier: 4, aliases: ['dailyexpress'] },
      'sunday-express': { displayName: 'Sunday Express', tier: 3, aliases: ['sunday-express', 'sundayexpress'] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets), []);
  });

  test('declared exceptions: david-cote/davidcote critic-name alias vs unrelated _aliasIndex routing entry does not flag (both slug and concatenated forms)', () => {
    const outlets = {
      'cote-notices': { displayName: 'Cote Notices', tier: 3, aliases: ['david cote'] },
      observer: { displayName: 'Observer', tier: 2, aliases: [] },
    };
    const aliasIndex = { 'david-cote': 'observer' };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets, aliasIndex), []);
  });

  test('_aliasIndex entries get the same slug/concatenated expansion as outlet-owned keys (task #1844 follow-up)', () => {
    // Regression for the asymmetry an adversarial review caught: an
    // _aliasIndex entry that's hyphenated ('metro-source') must still
    // collide with an outlet whose own id is the concatenated form
    // ('metrosource'), not just with another outlet's raw/the-stripped text.
    const outlets = {
      'metro-uk': { displayName: 'Metro UK', tier: 3, aliases: ['metro'] },
      metrosource: { displayName: 'Metrosource', tier: 3, aliases: [] },
    };
    const aliasIndex = { 'metro-source': 'metro-uk' };
    const collisions = findOutletAliasCollisions(outlets, aliasIndex);
    const hit = collisions.find((c) => c.key === 'metrosource');
    assert.ok(hit, 'expected a collision on the concatenated key "metrosource"');
    assert.deepStrictEqual(hit.outletIds, ['metro-uk', 'metrosource']);
  });
});

describe('findOutletAliasCollisions typo class (BRO-5577)', () => {
  for (const [canonical, typo] of [
    ['variety', 'varitey'], // adjacent transposition
    ['theatermania', 'theatermannia'], // insertion
    ['broadwayworld', 'broadwayworl'], // deletion at the end
    ['playbill', 'playblll'], // substitution
    ['playbill', 'xplaybill'], // insertion at the start
  ]) {
    test(`blocks ${typo} before it can be registered alongside ${canonical}`, () => {
      const outlets = { [canonical]: { displayName: canonical } };
      const entry = { displayName: typo, aliases: [typo] };
      assert.strictEqual(wouldCauseAliasCollision(outlets, {}, typo, entry), true);
      const hits = findOutletAliasCollisions({ ...outlets, [typo]: entry });
      assert.strictEqual(hits.length, 1, 'one finding per outlet pair');
      assert.deepStrictEqual(hits[0].outletIds, [canonical, typo].sort());
      assert.ok(hits[0].key.includes(canonical));
      assert.ok(hits[0].key.includes(typo));
    });
  }

  test('compares display names and aliases after stripping the and separators', () => {
    const outlets = {
      canonical: { displayName: 'The Broadway World', aliases: ['Stage Gazette'] },
      typo: { displayName: 'Broadway Wrold', aliases: ['Stage Gazete'] },
    };
    assert.deepStrictEqual(findOutletAliasCollisions(outlets)[0].outletIds, ['canonical', 'typo']);
    assert.strictEqual(findOutletAliasCollisions(outlets).length, 1);
  });

  test('also compares the independent alias index surface', () => {
    const outlets = { candidate: { displayName: 'Stage Gazete' } };
    assert.deepStrictEqual(
      findOutletAliasCollisions(outlets, { 'the-stage-gazette': 'existing' })[0].outletIds,
      ['candidate', 'existing']
    );
  });

  test('ignores same-outlet typo aliases, short abbreviations and multiple edits', () => {
    assert.deepStrictEqual(findOutletAliasCollisions({
      variety: { aliases: ['varitey', 'varietty'] },
      bbc: {}, nbc: {},
      playhouse: {}, playmousex: {},
      abcdefgh: {}, bcdefgha: {}, // a rotation is not an adjacent transposition
    }), []);
  });

  test('ignores sentinel identities in outlet entries and alias-index targets', () => {
    assert.deepStrictEqual(findOutletAliasCollisions({
      unknown: { displayName: 'Broadway Wrold' },
      broadwayworld: {},
      _meta: { displayName: 'Broadway Worl' },
    }, { 'broadway-worrld': 'unknown', _note: 'broadwayworld' }), []);
  });

  test('reports pairs deterministically, without duplicating existing exact collisions', () => {
    const outlets = { playbill: {}, playblll: {}, playbille: {}, duplicate: { aliases: ['playbill'] } };
    const forward = findOutletAliasCollisions(outlets);
    const reverse = findOutletAliasCollisions(Object.fromEntries(Object.entries(outlets).reverse()));
    assert.deepStrictEqual(forward, reverse);
    assert.strictEqual(forward.filter(c => c.outletIds.includes('duplicate') && c.outletIds.includes('playbill')).length, 1);
    assert.ok(forward.some(c => c.outletIds.includes('playbille') && c.outletIds.includes('playbill')));
  });

  test('declared distinct mastheads still allow an unrelated typo to be caught', () => {
    assert.deepStrictEqual(findOutletAliasCollisions({ independent: {}, indiependent: {} }), []);
    const hits = findOutletAliasCollisions({ independent: {}, indiependent: {}, independet: {} });
    assert.ok(hits.some(c => c.outletIds.includes('independet')));
    // A fuzzy exception must not suppress a real alias collision.
    assert.ok(findOutletAliasCollisions({ independent: {}, indiependent: { aliases: ['independent'] } }).length);
  });
});

describe('wouldCauseAliasCollision', () => {
  test('a candidate whose auto-generated displayName collides with an existing alias returns true (task #1843)', () => {
    // Same shape rebuild-all-reviews.js's AUTO-REGISTER block would build:
    // displayName is title-cased from the hyphenated id.
    const outlets = {
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: ['la times', 'los angeles times'] },
    };
    const candidateEntry = { displayName: 'The La Times', tier: 3, aliases: ['the-la-times'] };
    assert.strictEqual(wouldCauseAliasCollision(outlets, undefined, 'the-la-times', candidateEntry), true);
  });

  test('a non-colliding candidate returns false', () => {
    const outlets = {
      variety: { displayName: 'Variety', tier: 1, aliases: [] },
    };
    const candidateEntry = { displayName: 'Some New Outlet', tier: 3, aliases: ['some-new-outlet'] };
    assert.strictEqual(wouldCauseAliasCollision(outlets, undefined, 'some-new-outlet', candidateEntry), false);
  });

  test('a candidate colliding with a DIFFERENT candidate already written earlier in the same batch returns true', () => {
    // Reproduces Codex's "concrete silent failure #1": two colliding new
    // outlet IDs registered in the same rebuild run. Caller checks each
    // candidate against outletRegistry.outlets AS MUTATED by earlier
    // iterations of the same loop — simulate that by pre-adding the first
    // candidate before checking the second.
    const outlets = {
      'the-la-times': { displayName: 'The La Times', tier: 3, aliases: ['the-la-times'] },
    };
    const secondCandidateEntry = { displayName: 'La Times', tier: 3, aliases: ['la-times'] };
    assert.strictEqual(wouldCauseAliasCollision(outlets, undefined, 'la-times', secondCandidateEntry), true);
  });

  test('does not mutate the passed-in outlets map', () => {
    const outlets = { variety: { displayName: 'Variety', tier: 1, aliases: [] } };
    const before = JSON.stringify(outlets);
    wouldCauseAliasCollision(outlets, undefined, 'the-variety', { displayName: 'The Variety', tier: 3, aliases: ['the-variety'] });
    assert.strictEqual(JSON.stringify(outlets), before);
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

  test('adds the slugified and concatenated (no-hyphen) form of a spaced displayName (task #1844)', () => {
    const keys = buildOutletTextKeys('theater-news-online', { displayName: 'Theater News Online' });
    assert.ok(keys.includes('theater news online'), 'raw displayName');
    assert.ok(keys.includes('theater-news-online'), 'slugified displayName');
    assert.ok(keys.includes('theaternewsonline'), 'concatenated (no-hyphen) form');
  });

  test('does not add a redundant concatenated key when the slug already has no hyphens', () => {
    const keys = buildOutletTextKeys('variety', { displayName: 'Variety' });
    assert.deepStrictEqual(keys, ['variety']);
  });
});

describe('live registry', () => {
  test('rejects three typo candidates against real registry identities without changing the registry', () => {
    const { readFileSync } = require('fs');
    const registry = JSON.parse(readFileSync(resolve(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
    const before = JSON.stringify(registry);
    for (const [canonical, typo] of [
      ['variety', 'varitey'],
      ['theatermania', 'theatermannia'],
      ['broadwayworld', 'broadwayworl'],
    ]) {
      assert.ok(registry.outlets[canonical], `${canonical} must be a real registry entry`);
      assert.strictEqual(wouldCauseAliasCollision(registry.outlets, registry._aliasIndex, typo, {
        displayName: typo, aliases: [typo],
      }), true, typo);
    }
    assert.strictEqual(JSON.stringify(registry), before);
  });

  test('current outlet-registry.json has no unresolved near-duplicates', () => {
    const { readFileSync, existsSync } = require('fs');
    const registryPath = resolve(ROOT, 'data', 'outlet-registry.json');
    if (!existsSync(registryPath)) return; // data not checked out in this environment
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const collisions = findOutletAliasCollisions(registry.outlets || registry, registry._aliasIndex);
    assert.deepStrictEqual(
      collisions,
      [],
      `Found ${collisions.length} near-duplicate outlet collision(s): ${JSON.stringify(collisions, null, 2)}`
    );
  });
});
