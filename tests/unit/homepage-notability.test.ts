// Tests the pure homepage-notability rule that decides which off-Broadway shows
// surface on the Broadway homepage grid. Imports the REAL function (CLAUDE.md
// §15 — never re-implement logic in the test). Registered in the tsx unit batch
// in .github/workflows/test.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHomepageNotable,
  notabilityRank,
  NOTABILITY_THRESHOLDS,
  type NotabilitySignals,
} from '../../src/lib/homepage-notability';

// Minimal eligible base: open, non-opera, no auto-qualifying signal yet.
function base(overrides: Partial<NotabilitySignals> = {}): NotabilitySignals {
  return {
    status: 'open',
    type: 'play',
    isRevival: false,
    tags: [],
    t1Count: 0,
    reviewCount: 0,
    curatedAudience: 0,
    ...overrides,
  };
}

test('Path A — T1 turnout at threshold qualifies, just below does not', () => {
  assert.equal(isHomepageNotable(base({ t1Count: NOTABILITY_THRESHOLDS.minT1 })), true);
  assert.equal(isHomepageNotable(base({ t1Count: NOTABILITY_THRESHOLDS.minT1 - 1 })), false);
});

test('Path A — broad coverage at review threshold qualifies, just below does not', () => {
  assert.equal(isHomepageNotable(base({ reviewCount: NOTABILITY_THRESHOLDS.minReviews })), true);
  assert.equal(isHomepageNotable(base({ reviewCount: NOTABILITY_THRESHOLDS.minReviews - 1 })), false);
});

test('Real case — Small (T1=3, rc=9, new play, no buzz) is NOT notable', () => {
  // User explicitly flagged this: a critics'-darling new play is not "big".
  assert.equal(isHomepageNotable(base({ t1Count: 3, reviewCount: 9, curatedAudience: 80 })), false);
});

test('Real case — Jerome (T1=2, rc=16, new play) is NOT notable', () => {
  assert.equal(isHomepageNotable(base({ t1Count: 2, reviewCount: 16, curatedAudience: 69 })), false);
});

test('Path B — known property (revival) with audience buzz qualifies', () => {
  // Spelling Bee: T1=1, rc=7, but a recognizable revival with big footprint.
  assert.equal(
    isHomepageNotable(base({ type: 'musical', isRevival: true, t1Count: 1, reviewCount: 7, curatedAudience: 2617 })),
    true,
  );
});

test('Path B — NEW play with the same audience footprint does NOT qualify', () => {
  // Same footprint as the revival above, but not a known property → out.
  assert.equal(
    isHomepageNotable(base({ isRevival: false, tags: [], curatedAudience: 2617 })),
    false,
  );
});

test('Path B — "classic"/"tony-winner" tags count as known property', () => {
  assert.equal(
    isHomepageNotable(base({ tags: ['classic'], curatedAudience: NOTABILITY_THRESHOLDS.minCuratedAudience })),
    true,
  );
  assert.equal(
    isHomepageNotable(base({ tags: ['Tony-Winner'], curatedAudience: NOTABILITY_THRESHOLDS.minCuratedAudience })),
    true,
  );
});

test('Path B — known property below the audience floor does NOT qualify', () => {
  assert.equal(
    isHomepageNotable(base({ isRevival: true, curatedAudience: NOTABILITY_THRESHOLDS.minCuratedAudience - 1 })),
    false,
  );
});

test('Gate — opera is excluded even with heavy critic turnout', () => {
  assert.equal(isHomepageNotable(base({ type: 'opera', t1Count: 20, reviewCount: 50 })), false);
});

test('Gate — closed shows excluded; previews allowed', () => {
  assert.equal(isHomepageNotable(base({ status: 'closed', t1Count: 10 })), false);
  assert.equal(isHomepageNotable(base({ status: 'previews', t1Count: 10 })), true);
});

test('Override — homepageInclude forces in, even for an otherwise-ineligible show', () => {
  // A previews show with zero reviews (star-driven, pre-reviews) forced in.
  assert.equal(isHomepageNotable(base({ status: 'previews', t1Count: 0, reviewCount: 0, homepageInclude: true })), true);
});

test('Override — homepageExclude vetoes, even a strong auto-qualifier', () => {
  assert.equal(isHomepageNotable(base({ t1Count: 20, reviewCount: 50, homepageExclude: true })), false);
});

test('Override — exclude wins over include when both set', () => {
  assert.equal(isHomepageNotable(base({ homepageInclude: true, homepageExclude: true })), false);
});

test('notabilityRank orders critic turnout above coverage above audience', () => {
  const heavyT1 = base({ t1Count: 11, reviewCount: 20, curatedAudience: 9648 });
  const heavyReviews = base({ t1Count: 5, reviewCount: 21, curatedAudience: 81 });
  const heavyAudienceOnly = base({ t1Count: 1, reviewCount: 7, curatedAudience: 2617 });
  assert.ok(notabilityRank(heavyT1) > notabilityRank(heavyReviews));
  assert.ok(notabilityRank(heavyReviews) > notabilityRank(heavyAudienceOnly));
});
