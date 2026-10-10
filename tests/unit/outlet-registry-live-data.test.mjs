// TESTS-VS-DERIVED-DATA-EXEMPT: live-registry state checks, run by
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

