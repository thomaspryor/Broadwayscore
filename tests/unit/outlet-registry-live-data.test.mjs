// live-registry state checks, run by
// check-corpus-drift.yml (data-health), not test.yml's code-CI unit batch.
/**
 * Live outlet-registry audit (BRO-1343), moved out of
 * scripts/outlet-registry.test.mjs on 2026-09-29 (BRO-3425): the rebuild
 * auto-registers outlets and commits data/outlet-registry.json to main many
 * times a day, so a registry-state finding (51 domainless outlets, from BWW
 * critic-name phantoms) turned main's Test Suite red with no code change.
 *
 * Why the ceiling exists: on 2026-06-21, 373 of 968 outlets had domain:null,
 * so buildSiteClause's per-outlet Google SERP couldn't site-restrict them
 * (Bachtrack missed a This Is Rambert review). This pins the null-domain count
 * under a ceiling and keeps every primary domain collision-free.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { findUndeclaredDomainCollisions } = require(
  resolve(ROOT, 'scripts/lib/outlet-registry-domain-collisions.js')
);

const registry = JSON.parse(readFileSync(resolve(ROOT, 'data', 'outlet-registry.json'), 'utf8'));

const NULL_DOMAIN_CEILING = 50;

describe('outlet-registry.json domain audit (BRO-1343)', () => {
  test(`fewer than ${NULL_DOMAIN_CEILING} outlets have a null domain`, () => {
    const nullDomainIds = Object.entries(registry.outlets)
      // Defunct outlets have no live site for a SERP search to restrict to, and
      // rebuild auto-register keeps adding URL-less defunct entries (BRO-4362:
      // 51 vs ceiling 50 on 2026-09-29), so they don't count against the ceiling.
      .filter(([, outlet]) => !outlet.domain && outlet.accessModel !== 'defunct')
      .map(([id]) => id);
    assert.ok(
      nullDomainIds.length < NULL_DOMAIN_CEILING,
      `${nullDomainIds.length} outlets still have domain:null (ceiling ${NULL_DOMAIN_CEILING}). ` +
        `A per-outlet SERP search can't site-restrict any of these:\n  ${nullDomainIds.join(', ')}`
    );
  });

  test('no undeclared primary-domain collisions after the backfill pass', () => {
    const collisions = findUndeclaredDomainCollisions(registry.outlets);
    assert.deepEqual(
      collisions,
      [],
      `undeclared domain collision(s): ${collisions.map((c) => `${c.domain} <- ${c.outletIds.join(', ')}`).join('; ')}`
    );
  });
});


// BRO-5728: moved here from tests/unit/outlet-registry-display-names.test.mjs.
// Rebuild auto-registers outlets offline and capitalizes the id when nothing
// better is known ("Hackneycitizen", BRO-5336), so this count rose with no
// code change and reddened unit-tests-node on main in 34 land runs on
// 2026-10-19. check-corpus-drift.yml repairs fetchable names just before
// this check runs.
const { findRunTogetherSlugDisplayNames } = require(resolve(ROOT, 'scripts', 'lib', 'outlet-auto-register.js'));
const MAX_SLUG_DISPLAY_NAMES = 10; // BRO-5732: writers now fail closed, so new slug names cannot arrive; lower to 0 once the live registry is clean

test(`live registry: at most ${MAX_SLUG_DISPLAY_NAMES} displayNames are the capitalized run-together id`, () => {
  const rows = findRunTogetherSlugDisplayNames(registry.outlets || registry);
  assert.ok(
    rows.length <= MAX_SLUG_DISPLAY_NAMES,
    `${rows.length} slug-shaped displayNames (max ${MAX_SLUG_DISPLAY_NAMES}): ${rows.slice(0, 15).map((r) => r.outletId).join(', ')}. `
      + 'Fix with node scripts/audit-registry-slug-displaynames.js --fetch --apply, or stamp displayNameReviewed:true on a genuine one-word masthead.',
  );
});

// BRO-7822: "Quality: outlet domain moves" was filed 3 times in 30 days (BRO-7335, BRO-7411, BRO-7761).
// The health check only warned in the daily digest, a card was filed, and a worker hand-added one host.
// Nothing failed in the data-health run that sees the registry and census together, so each new host
// became a fresh card. This pins the same detector the health check uses to ZERO unresolved moves
// against the committed census: resolve a flagged host with domainAliases (it moved) or notDomainMoves
// (checked, different paper), see scripts/lib/outlet-registry-alias-action.js.
describe('outlet domain moves (BRO-7822)', () => {
  const { findProbableDomainMoves } = require(resolve(ROOT, 'scripts/lib/silent-exclusion-detectors.js'));
  const censusPath = resolve(ROOT, 'data', 'audit', 'unknown-aggregator-outlets.json');

  test('no census host is an unresolved probable move of a registered outlet', () => {
    const census = JSON.parse(readFileSync(censusPath, 'utf8'));
    const moves = findProbableDomainMoves(registry.outlets, census.outlets || []);
    assert.deepEqual(
      moves.map((m) => `${m.host} -> ${m.outletId}`),
      [],
      'unresolved domain move(s): add the host to that outlet\'s domainAliases (moved) or notDomainMoves (different paper)'
    );
  });

  test('detector flags a host that name-matches a registered outlet domain (guard is live)', () => {
    const outlets = { 'some-outlet': { domain: 'someoutlet.com' } };
    const moves = findProbableDomainMoves(outlets, [{ host: 'someoutlet.co.uk' }]);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].outletId, 'some-outlet');
    // and resolving it clears it
    outlets['some-outlet'].domainAliases = ['someoutlet.co.uk'];
    assert.equal(findProbableDomainMoves(outlets, [{ host: 'someoutlet.co.uk' }]).length, 0);
  });
});
