/**
 * Registry domain audit regression guard (BRO-1343).
 *
 * 2026-06-21: 373 of 968 outlets (39%) had domain:null, so
 * buildSiteClause's per-outlet Google SERP couldn't site-restrict a search
 * for them at all — Bachtrack (a major UK dance review site) was one of
 * them, and This Is Rambert missed its review until a manual fix. This pins
 * the null-domain count below a hard ceiling so the registry can't silently
 * regress back toward that state (e.g. a bulk outlet import that never sets
 * domain), and locks in that every outlet's primary domain is still
 * collision-free after the 2026-09-15 backfill/prune pass.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { findUndeclaredDomainCollisions } = require(
  resolve(ROOT, 'scripts/lib/outlet-registry-domain-collisions.js')
);

const registry = JSON.parse(readFileSync(resolve(ROOT, 'data', 'outlet-registry.json'), 'utf8'));

const NULL_DOMAIN_CEILING = 50;

describe('outlet-registry.json domain audit (BRO-1343)', () => {
  test(`fewer than ${NULL_DOMAIN_CEILING} outlets have a null domain`, () => {
    const nullDomainIds = Object.entries(registry.outlets)
      .filter(([, outlet]) => !outlet.domain)
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
