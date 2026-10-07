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
 *
 * 2026-09-29 (BRO-3425): those two LIVE-registry assertions moved to
 * tests/unit/outlet-registry-live-data.test.mjs, run by check-corpus-drift.yml.
 * The rebuild auto-registers outlets and commits the registry to main many
 * times a day, so a registry-state finding turned main's code CI red with no
 * code change. What stays here are synthetic-fixture tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { isExcludedFromOutletRegistryAudit } = require(
  resolve(ROOT, 'scripts/lib/outlet-registry-audit-exclusions.js')
);

// audit-outlet-registry.js's 5 exclusion branches (BRO-3804): a review file
// matching any of these never needs a registry entry, so --strict must not
// flag its outletId as a NEW gap. Exercised here via synthetic fixtures
// (scripts/lib/outlet-registry-audit-exclusions.js) instead of real
// review-texts, per the Test Extraction Pattern (CLAUDE.md #15).
describe('isExcludedFromOutletRegistryAudit (BRO-3804)', () => {
  test('a normal scored review is NOT excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({ outletId: 'new-outlet', url: 'https://new-outlet.com/review', humanReviewScore: 85 }),
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
        humanReviewScore: 72, // scored: branch 6 (unscored, BRO-4401) must not be what decides this case
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
        humanReviewScore: 66, // scored: branch 6 (unscored, BRO-4401) must not be what decides this case
      }),
      false
    );
  });

  test('branch 5: an unscored review with a human wrongShowCleared verdict is NOT excluded', () => {
    // Real-corpus regression (the-komisar-scoop class): a human explicitly
    // cleared wrongProduction/wrongShow on a url_content_mismatch file
    // before scoring happened. The manual clear must win, same as branch 4.
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'the-komisar-scoop',
        incompleteReason: 'url_content_mismatch',
        wrongProductionManualClear: true,
        wrongShowManualClear: true,
      }),
      false
    );
  });

  test('branch 5: a stale incompleteReason on an already-scored review is NOT excluded', () => {
    // Real-corpus regression: incompleteReason is informational metadata
    // that clearFailureFlags() should null out once a file is scored, but
    // thousands of older files carry a stale wrong_content/scraper_garbage
    // reason alongside a perfectly valid score. Without the hasValidScore()
    // guard, branch 5 would hide these outlets' registry gaps.
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'nytimes',
        incompleteReason: 'wrong_content',
        humanReviewScore: 78, // a score the rebuild itself accepts (a bare single-model llmScore is blockedSingleModel there)
      }),
      false
    );
  });
});

// BRO-4370 / BRO-4401: the rebuild's auto-register pass used to write a
// `domain: null` registry row for every unknown outletId on an included
// review — including critic bylines an aggregator parser had turned into
// outlet ids (paula-citron, ben-ryland, bill-sullivan on 2026-09-29), which
// pushed the null-domain ceiling to 51/50 and turned main red with no code
// change. decideOutletAutoRegistration() is the real decision the rebuild
// now calls (scripts/lib/outlet-auto-register.js); these pin every branch.
const {
  decideOutletAutoRegistration,
  criticNameSlugs,
  mergeStagingEntries,
  STAGE_REASONS,
} = require(resolve(ROOT, 'scripts/lib/outlet-auto-register.js'));

describe('decideOutletAutoRegistration (BRO-4370): register only with a resolvable domain', () => {
  const criticSlugs = criticNameSlugs({
    critics: {
      'paula-citron': { displayName: 'Paula Citron' },
      'john-oconnor': { displayName: "John O'Connor" },
    },
  });

  test('an unknown outlet WITH a URL-derived domain is registered with that domain', () => {
    assert.deepEqual(
      decideOutletAutoRegistration({ outletId: 'splitdecision', domainHint: 'splitdecision.co', criticSlugs }),
      { action: 'register', domain: 'splitdecision.co' },
    );
  });

  test('a critic-registry name is staged, never registered — even with a domain hint', () => {
    assert.deepEqual(
      decideOutletAutoRegistration({ outletId: 'paula-citron', domainHint: 'ludwig-van.com', criticSlugs }),
      { action: 'stage', reason: STAGE_REASONS.CRITIC_NAME },
    );
    // display-name slug with the apostrophe dropped, matching review-normalization's slugify
    assert.equal(decideOutletAutoRegistration({ outletId: 'john-oconnor', domainHint: 'x.com', criticSlugs }).action, 'stage');
  });

  test("a critic's OWN site (name == domain) is a real outlet and registers", () => {
    const slugs = criticNameSlugs({ critics: { 'carole-di-tosti': { displayName: 'Carole Di Tosti' } } });
    assert.deepEqual(
      decideOutletAutoRegistration({ outletId: 'carole-di-tosti', domainHint: 'caroleditosti.com', criticSlugs: slugs }),
      { action: 'register', domain: 'caroleditosti.com' },
    );
    // same name, URL evidence points at someone else's site → mis-filed byline
    assert.equal(decideOutletAutoRegistration({ outletId: 'carole-di-tosti', domainHint: 'broadwayworld.com', criticSlugs: slugs }).reason, STAGE_REASONS.CRITIC_NAME);
  });

  test('no resolvable domain → staged (the old domain:null row is never written)', () => {
    assert.deepEqual(
      decideOutletAutoRegistration({ outletId: 'from-the-fourth-row', domainHint: null, criticSlugs }),
      { action: 'stage', reason: STAGE_REASONS.NO_DOMAIN },
    );
  });

  test('a hint domain that collides with a registered outlet → staged (task #1776 case)', () => {
    assert.deepEqual(
      decideOutletAutoRegistration({ outletId: 'the-times-barbican', domainHint: 'thetimes.co.uk', domainCollides: true, criticSlugs }),
      { action: 'stage', reason: STAGE_REASONS.DOMAIN_COLLISION },
    );
  });

  test('a byline the critic REGISTRY has never seen is still caught via the rebuild\'s own criticNames (the BRO-4370 shape)', () => {
    // data/critic-registry.json is generated from attributed reviews, so on
    // 2026-09-29 none of the three mis-filed bylines were in it; their names
    // rode on the correctly attributed twin records in the same rebuild.
    const slugs = criticNameSlugs(
      { critics: {} },
      [
        { outletId: 'media-mikes', criticName: 'Ben Ryland' },
        { outletId: 'ludwig-van', criticName: 'Paula Citron' },
        { outletId: 'nytimes', criticName: 'Unknown' },
        { outletId: 'x', criticName: null },
      ],
    );
    assert.ok(slugs.has('ben-ryland') && slugs.has('paula-citron'));
    assert.ok(!slugs.has('unknown'), 'sentinel bylines are never critic slugs');
    assert.equal(decideOutletAutoRegistration({ outletId: 'ben-ryland', domainHint: null, criticSlugs: slugs }).reason, STAGE_REASONS.CRITIC_NAME);
  });

  test('critic matching is case-insensitive and survives an unreadable critic registry', () => {
    assert.equal(decideOutletAutoRegistration({ outletId: 'Paula-Citron', domainHint: 'x.com', criticSlugs }).action, 'stage');
    assert.equal(criticNameSlugs(null).size, 0);
    assert.deepEqual(
      decideOutletAutoRegistration({ outletId: 'paula-citron', domainHint: 'x.com', criticSlugs: criticNameSlugs(null) }),
      { action: 'register', domain: 'x.com' },
    );
  });
});

describe('mergeStagingEntries: the staging list is keyed, keeps firstSeenAt, and self-prunes', () => {
  const t0 = '2026-09-29T12:00:00.000Z';
  const t1 = '2026-09-30T00:00:00.000Z';

  test('a re-staged outlet keeps its firstSeenAt and refreshes the rest', () => {
    const existing = [{ outletId: 'vu', reason: 'no-domain', reviewCount: 1, exampleShowId: 'a', firstSeenAt: t0, lastSeenAt: t0 }];
    const merged = mergeStagingEntries(existing, [{ outletId: 'vu', reason: 'no-domain', reviewCount: 3, exampleShowId: 'b' }], { nowIso: t1 });
    assert.deepEqual(merged, [{ outletId: 'vu', reason: 'no-domain', domainHint: null, reviewCount: 3, exampleShowId: 'b', firstSeenAt: t0, lastSeenAt: t1 }]);
  });

  test('an outlet that has since been registered drops out; output is sorted by id', () => {
    const existing = [
      { outletId: 'zebra', reason: 'no-domain', firstSeenAt: t0, lastSeenAt: t0 },
      { outletId: 'abc14', reason: 'no-domain', firstSeenAt: t0, lastSeenAt: t0 },
    ];
    const merged = mergeStagingEntries(existing, [], { nowIso: t1, stillUnregistered: (id) => id !== 'zebra' });
    assert.deepEqual(merged.map((e) => e.outletId), ['abc14']);
  });

  test('empty inputs are fine', () => {
    assert.deepEqual(mergeStagingEntries(undefined, undefined, { nowIso: t1 }), []);
  });
});

describe('isExcludedFromOutletRegistryAudit branch 6 (BRO-4401): unscored files, which the rebuild never includes', () => {
  test('an unscored file WITHOUT the pending flag is excluded too (goodstoriespodcast / ourquadcities / crisesnotes, 2026-09-30: skippedNoScore by the rebuild, red in --strict)', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'ourquadcities',
        url: 'https://www.ourquadcities.com/news/local-news/alice-in-wonderland-ballet/',
        criticName: 'Linda Cook',
        publishDate: '2026-09-29',
      }),
      true,
    );
  });

  test('a submit-review-form file still waiting on score extraction is excluded', () => {
    // localwineevents--unknown.json / splitdecision--liam-bellman-sharpe.json
    // shape on 2026-09-29: archive fetch, <200 words, no score yet. The rebuild
    // never includes an unscored file, so nothing can register its outlet.
    assert.equal(
      isExcludedFromOutletRegistryAudit({
        outletId: 'localwineevents',
        url: 'https://www.localwineevents.com/view/event/x/928060',
        source: 'submit-review-form',
        scoreExtractionPending: true,
        contentTier: 'truncated',
        wordCount: 187,
      }),
      true,
    );
  });

  test('a scored file with a stale scoreExtractionPending flag is NOT excluded', () => {
    assert.equal(
      isExcludedFromOutletRegistryAudit({ outletId: 'nytimes', scoreExtractionPending: true, humanReviewScore: 80 }),
      false,
    );
  });

  test('a SCORED file on an unregistered outlet is still a real registry gap (every score source counts)', () => {
    assert.equal(isExcludedFromOutletRegistryAudit({ outletId: 'new-outlet', url: 'https://new-outlet.com/review', adjudicatedScore: 71 }), false);
    assert.equal(isExcludedFromOutletRegistryAudit({ outletId: 'new-outlet', url: 'https://new-outlet.com/review', assignedScore: 64 }), false);
    assert.equal(isExcludedFromOutletRegistryAudit({ outletId: 'new-outlet', url: 'https://new-outlet.com/review', originalScore: '4/5' }), false);
  });

  test('the predicate is the REBUILD\'s (getBestScore), not hasValidScore: a bare single-model llmScore is blockedSingleModel there, so it is excluded here too', () => {
    assert.equal(isExcludedFromOutletRegistryAudit({ outletId: 'new-outlet', url: 'https://new-outlet.com/review', llmScore: { score: 71 } }), true);
  });
});

describe('partitionAwaitingRebuild (BRO-4401): files newer than the last rebuild are reported, not failed', () => {
  const { partitionAwaitingRebuild } = require(resolve(ROOT, 'scripts/lib/outlet-registry-baseline.js'));
  const rebuiltAt = Date.parse('2026-09-30T00:10:52.114Z');

  test('a violator first seen after the rebuild is deferred; one seen before stays actionable', () => {
    const { awaitingRebuild, actionable } = partitionAwaitingRebuild(
      [
        { outletId: 'ourquadcities', earliestSeenAt: '2026-09-30T01:05:00.000Z' },
        { outletId: 'old-gap', earliestSeenAt: '2026-09-20T01:05:00.000Z' },
      ],
      rebuiltAt,
    );
    assert.deepEqual(awaitingRebuild.map((v) => v.outletId), ['ourquadcities']);
    assert.deepEqual(actionable.map((v) => v.outletId), ['old-gap']);
  });

  test('unknown rebuild time or missing earliestSeenAt → nothing is deferred (old behaviour)', () => {
    const rows = [{ outletId: 'a', earliestSeenAt: '2026-09-30T01:05:00.000Z' }, { outletId: 'b' }];
    assert.equal(partitionAwaitingRebuild(rows, NaN).awaitingRebuild.length, 0);
    assert.equal(partitionAwaitingRebuild(rows, null).actionable.length, 2);
    assert.deepEqual(partitionAwaitingRebuild(rows, rebuiltAt).actionable.map((v) => v.outletId), ['b']);
  });
});

describe('outletRegistryAuditExclusionBranch (BRO-4401): the audit counts branch-6 files on their own', () => {
  const { outletRegistryAuditExclusionBranch } = require(resolve(ROOT, 'scripts/lib/outlet-registry-audit-exclusions.js'));

  test('an unscored file on a BLOCKED domain is branch 3, not 6 — it is not "waiting to score"', () => {
    assert.equal(outletRegistryAuditExclusionBranch({ outletId: 'tickpick', url: 'https://www.tickpick.com/some-listing' }), 3);
  });

  test('a plain unscored file is branch 6; a scored one is 0 (in scope)', () => {
    assert.equal(outletRegistryAuditExclusionBranch({ outletId: 'ourquadcities', url: 'https://www.ourquadcities.com/x' }), 6);
    assert.equal(outletRegistryAuditExclusionBranch({ outletId: 'ourquadcities', url: 'https://www.ourquadcities.com/x', humanReviewScore: 70 }), 0);
    assert.equal(isExcludedFromOutletRegistryAudit({ outletId: 'ourquadcities', url: 'https://www.ourquadcities.com/x' }), true);
  });
});
