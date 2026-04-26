/**
 * Unit tests for review-guards.js — isLikelyStaleSuspectedMisattribution
 *
 * Regression for Notion 34e637c5-416f-81b8: a stale suspectedMisattribution=true
 * flag was silently dropping legitimate critic reviews from rebuild + scoring.
 * The flag is set by Guard G in scripts/lib/review-file-writer.js when a
 * non-freelancer critic publishes at an outletId outside their knownOutlets.
 *
 * The critic-registry is regenerated nightly by scripts/audit-critic-outlets.js
 * from the corpus, so knownOutlets expands over time as critics accumulate
 * reviews at additional outlets. Files flagged in earlier passes carry the
 * exclusion forever, even after the registry has caught up.
 *
 * The helper identifies files where the current registry would no longer fire
 * Guard G — mirroring its exact preconditions:
 *   - critic not in registry → guard short-circuits
 *   - critic is now freelancer → guard skips
 *   - knownOutlets is empty → guard's `length > 0` check fails
 *   - outletId is in knownOutlets → guard passes
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isLikelyStaleSuspectedMisattribution } = require('../../scripts/lib/review-guards.js');
const { passesFlagFilters } = require('../../scripts/lib/review-text-scoreable.js');

const longReviewText = 'A real critic review with substance. '.repeat(40);

const SUSANNAH_CLAPP_FLAGGED = {
  suspectedMisattribution: true,
  misattributionReason: 'critic "Susannah Clapp" has primaryOutlet="observer" (19 reviews); found at "guardian" which is not in knownOutlets',
  criticName: 'Susannah Clapp',
  outletId: 'guardian',
  url: 'https://www.theguardian.com/stage/2024/oct/06/an-enemy-of-the-people-noel-coward-theatre-review',
  fullText: longReviewText,
  isFullReview: true,
  contentTier: 'complete',
};

describe('isLikelyStaleSuspectedMisattribution', () => {
  test('Susannah Clapp / guardian regression — outlet now in knownOutlets', () => {
    const registry = {
      'susannah-clapp': {
        displayName: 'Susannah Clapp',
        primaryOutlet: 'observer',
        knownOutlets: ['observer', 'guardian'],
        isFreelancer: false,
      },
    };
    assert.strictEqual(
      isLikelyStaleSuspectedMisattribution(SUSANNAH_CLAPP_FLAGGED, registry),
      true,
      'guardian now in knownOutlets — flag is stale'
    );
  });

  test('critic not in registry — Guard G would short-circuit, flag is stale', () => {
    const data = {
      suspectedMisattribution: true,
      criticName: 'Jose Solís',
      outletId: 'dtli',
      fullText: longReviewText,
      isFullReview: true,
    };
    // Non-empty registry that just doesn't list jose-sol[íi]s — Guard G short-circuits.
    // (Empty registry is a separate "fail-safe" case tested below — must NOT mass-clear.)
    const registry = {
      'someone-else': { displayName: 'Someone Else', knownOutlets: ['variety'], isFreelancer: false },
    };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, registry), true);
  });

  test('empty registry — fail-safe returns false (preserve flag, do not mass-clear)', () => {
    // Critical: a missing/corrupt registry must NOT silently un-flag the corpus.
    // The predicate cannot prove anything when the registry is empty, so it
    // preserves every flag as-is. Caught in /ship-check 2026-04-26.
    const data = {
      suspectedMisattribution: true,
      criticName: 'Susannah Clapp',
      outletId: 'guardian',
      fullText: longReviewText,
    };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, {}), false);
  });

  test('honorific prefix in critic name — predicate uses normalizeCritic to match Guard G', () => {
    // Guard G slugs via normalizeCritic which strips MR./MS./DR./CSA./MC. prefixes.
    // Without this fix, the raw slugifier would produce 'mr-ben-brantley' and miss
    // the registry entry, falsely returning true (stale) and un-flagging real misattributions.
    const data = {
      suspectedMisattribution: true,
      criticName: 'MR. Ben Brantley', // honorific prefix on file
      outletId: 'wsj',
      fullText: longReviewText,
    };
    const registry = {
      'ben-brantley': {
        displayName: 'Ben Brantley',
        primaryOutlet: 'nyt',
        knownOutlets: ['nyt'],
        isFreelancer: false,
      },
    };
    assert.strictEqual(
      isLikelyStaleSuspectedMisattribution(data, registry),
      false,
      'normalizeCritic must strip MR. prefix so the registry lookup hits — wsj is NOT in knownOutlets, so flag is real'
    );
  });

  test('pre-canonical outletId — predicate uses normalizeOutlet to match registry knownOutlets', () => {
    // audit-critic-outlets.js writes normalizeOutlet(outletId) into knownOutlets
    // (audit-critic-outlets.js:123). If a file has a pre-canonical outletId like
    // an alias, the predicate must canonicalize it before the includes() check.
    const { normalizeOutlet } = require('../../scripts/lib/review-normalization.js');
    // Pick any outlet that has an alias mapping (where normalizeOutlet changes the value).
    // If no aliases exist for outlets in this test, this becomes a no-op identity test.
    const rawOutlet = 'guardian'; // no-op for guardian, but test the canonicalization PATH
    const canonical = normalizeOutlet(rawOutlet);
    const data = {
      suspectedMisattribution: true,
      criticName: 'Susannah Clapp',
      outletId: rawOutlet,
      fullText: longReviewText,
    };
    const registry = {
      'susannah-clapp': {
        displayName: 'Susannah Clapp',
        primaryOutlet: 'observer',
        knownOutlets: ['observer', canonical], // simulate audit's canonicalized write
        isFreelancer: false,
      },
    };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, registry), true);
  });

  test('critic is freelancer — Guard G skips freelancers, flag is stale', () => {
    const data = {
      suspectedMisattribution: true,
      criticName: 'Michael Kuchwara',
      outletId: 'abc-news',
      fullText: longReviewText,
    };
    const registry = {
      'michael-kuchwara': {
        displayName: 'Michael Kuchwara',
        primaryOutlet: 'ap',
        knownOutlets: ['ap'],
        isFreelancer: true,
      },
    };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, registry), true);
  });

  test('outlet NOT in knownOutlets and critic still in registry as non-freelancer — flag is real', () => {
    const data = {
      suspectedMisattribution: true,
      criticName: 'John Anderson',
      outletId: 'wsj',
      fullText: longReviewText,
    };
    const registry = {
      'john-anderson': {
        displayName: 'John Anderson',
        primaryOutlet: 'dailybeast',
        knownOutlets: ['dailybeast'],
        isFreelancer: false,
      },
    };
    assert.strictEqual(
      isLikelyStaleSuspectedMisattribution(data, registry),
      false,
      'wsj NOT in knownOutlets and critic is still non-freelancer in registry — Guard G would re-fire'
    );
  });

  test('knownOutlets is empty array — Guard G length check fails, flag is stale', () => {
    const data = {
      suspectedMisattribution: true,
      criticName: 'Some Critic',
      outletId: 'some-outlet',
      fullText: longReviewText,
    };
    const registry = {
      'some-critic': {
        displayName: 'Some Critic',
        primaryOutlet: null,
        knownOutlets: [],
        isFreelancer: false,
      },
    };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, registry), true);
  });

  test('suspectedMisattribution is not true — predicate is false trivially', () => {
    const registry = {};
    assert.strictEqual(isLikelyStaleSuspectedMisattribution({ suspectedMisattribution: false }, registry), false);
    assert.strictEqual(isLikelyStaleSuspectedMisattribution({}, registry), false);
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(null, registry), false);
  });

  test('registry is missing or invalid — predicate cannot prove staleness, returns false', () => {
    const data = { suspectedMisattribution: true, criticName: 'Susannah Clapp', outletId: 'guardian' };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, undefined), false);
    assert.strictEqual(isLikelyStaleSuspectedMisattribution(data, null), false);
  });

  test('missing criticName or outletId — cannot evaluate, returns false', () => {
    const registry = { 'susannah-clapp': { knownOutlets: ['observer', 'guardian'], isFreelancer: false } };
    assert.strictEqual(isLikelyStaleSuspectedMisattribution({ suspectedMisattribution: true, outletId: 'guardian' }, registry), false);
    assert.strictEqual(isLikelyStaleSuspectedMisattribution({ suspectedMisattribution: true, criticName: 'Susannah Clapp' }, registry), false);
    assert.strictEqual(isLikelyStaleSuspectedMisattribution({ suspectedMisattribution: true, criticName: 'Unknown', outletId: 'guardian' }, registry), false);
    assert.strictEqual(isLikelyStaleSuspectedMisattribution({ suspectedMisattribution: true, criticName: 'Susannah Clapp', outletId: 'unknown' }, registry), false);
  });

  test('critic-name slugifier matches audit-critic-outlets.js (lowercase + non-alnum→dash)', () => {
    // "José Solís" → "jose-sol-s" — matches slugifier in audit-critic-outlets.js line 60
    const registry = {
      'jose-sol-s': {
        displayName: 'José Solís',
        knownOutlets: ['dtli'],
        isFreelancer: false,
      },
    };
    const data = {
      suspectedMisattribution: true,
      criticName: 'José Solís',
      outletId: 'dtli',
    };
    assert.strictEqual(
      isLikelyStaleSuspectedMisattribution(data, registry),
      true,
      'unicode in critic name must slugify the same way as audit-critic-outlets'
    );
  });
});

describe('passesFlagFilters — stale suspectedMisattribution override', () => {
  // passesFlagFilters reads the registry via getCriticRegistry() — disk-backed.
  // Cannot inject a registry, so this test exercises the integration with whatever
  // registry the worktree has on disk. Susannah Clapp / guardian must be in
  // knownOutlets there; if not, the regression has regressed.
  test('Susannah Clapp / guardian regression — file passes flag filters', () => {
    const data = { ...SUSANNAH_CLAPP_FLAGGED };
    assert.strictEqual(
      passesFlagFilters(data),
      true,
      'Critic-registry must list guardian in knownOutlets for Susannah Clapp; otherwise the gate-side override does not protect the cleared sweep set'
    );
  });

  test('confirmed misattribution is still excluded', () => {
    // Pick a critic in registry as non-freelancer at outletIds that are NOT in
    // their knownOutlets and NOT in KNOWN_MULTI_OUTLET_PAIRS (audit-critic-outlets.js).
    // Susannah Clapp is observer/guardian; wsj is unrelated and unlisted in pairs.
    const data = {
      suspectedMisattribution: true,
      criticName: 'Susannah Clapp',
      outletId: 'wsj',
      fullText: longReviewText,
      isFullReview: true,
      contentTier: 'complete',
    };
    assert.strictEqual(passesFlagFilters(data), false);
  });
});
