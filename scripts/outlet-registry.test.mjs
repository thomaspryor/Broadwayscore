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
const { isExcludedFromOutletRegistryAudit } = require(
  resolve(ROOT, 'scripts/lib/outlet-registry-audit-exclusions.js')
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

// audit-outlet-registry.js's 5 exclusion branches (BRO-3804): a review file
// matching any of these never needs a registry entry, so --strict must not
// flag its outletId as a NEW gap. Exercised here via synthetic fixtures
// (scripts/lib/outlet-registry-audit-exclusions.js) instead of real
// review-texts, per the Test Extraction Pattern (CLAUDE.md #15).
describe('isExcludedFromOutletRegistryAudit (BRO-3804)', () => {
  test('a normal scored review is NOT excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({ outletId: 'new-outlet', url: 'https://new-outlet.com/review', score: 85 }),
      false
    );
  });

  test('branch 1: isNonReview:true with no corroborating fresh CV is excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({ outletId: 'junk-outlet', isNonReview: true }),
      true
    );
  });

  test('branch 1: isNonReview:true demoted by a fresh high-confidence CV is NOT excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'telegraph-class',
        isNonReview: true,
        contentVerification: {
          articleType: 'review',
          isValid: true,
          articleTypeConfidence: 'high',
          verifiedAt: '2026-09-01T00:00:00Z',
        },
      }),
      false
    );
  });

  test('branch 2: ensemble-rejected non-review (contentTier invalid) is excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({ outletId: 'garbage-outlet', contentTier: 'invalid' }),
      true
    );
  });

  test('branch 3: URL on a known blocked (ticketing) domain is excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({ outletId: 'todaytix', url: 'https://todaytix.com/nyc/shows/foo' }),
      true
    );
  });

  test('branch 4: confidently rejected wrong_production with no manual clear is excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'stalbanstimes',
        rejectionReason: 'wrong_production',
        rejectedAt: '2026-08-01T00:00:00Z',
      }),
      true
    );
  });

  test('branch 4: wrong_production rejection with a manual clear is NOT excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'stalbanstimes',
        rejectionReason: 'wrong_production',
        rejectedAt: '2026-08-01T00:00:00Z',
        wrongProductionManualClear: true,
      }),
      false
    );
  });

  test('branch 5: incompleteReason in WRONG_URL_INCOMPLETE is excluded (BRO-3794)', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'southasianheritage-off-west-end',
        incompleteReason: 'url_content_mismatch',
        incompleteDetail: 'show mentioned 0x (below 1 threshold for 1077-char text, titleMatch=true)',
      }),
      true
    );
  });

  test('branch 5: an unrelated incompleteReason is NOT excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'new-outlet',
        url: 'https://new-outlet.com/review',
        incompleteReason: 'paywalled',
      }),
      false
    );
  });
});
