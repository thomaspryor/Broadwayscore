/**
 * Guards the self-healing review-recovery decision logic in
 * scripts/lib/flagged-recovery.js — the merge-safe empty-body subset that the
 * hourly audit-aggregator-gap loop re-ingests automatically.
 *
 * Why this exists (Notion 387637c5-416f-81c6): new openings land "short" because
 * paywalled reviews get a discovered URL but an empty fetched body, so the file
 * exists yet never becomes includable (Glengarry WE empty Times review). The
 * recovery loop re-fetches the aggregator's current-production URL and MERGES the
 * text in. This freezes the four safety contracts:
 *   1. empty-body, in-window, no flags  → recover
 *   2. dead URL → aggUrlRecoveryCount hits cap 3 → STOP (no infinite re-fetch / credit burn)
 *   3. correct prior-production exclusion (wrongProduction) → NEVER re-fetched
 *   4. human-protected file (humanReviewScore / manual clear / verified production) → NEVER touched
 *
 * Per CLAUDE.md §15 we require() the real decision functions — production changes
 * that weaken any guard fail this test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  FLAGGED_RECOVERY_CAP,
  isEmptyBodyFile,
  isRecoverableFlaggedFile,
  isRecoverableUncitedStub,
  looksLikeReviewUrl,
  shouldSkipNonReviewStamp,
  STAR_SOURCE_BY_REFERENCE,
  decideEmptyBodyRecovery,
  nextRecoveryCount,
} = require('../../scripts/lib/flagged-recovery.js');

const AGG_URL = 'https://www.thetimes.com/article/glengarry-2026-review';

describe('flagged-recovery: empty-body detection', () => {
  test('absent / short / whitespace fullText is empty-body', () => {
    assert.equal(isEmptyBodyFile({}), true);
    assert.equal(isEmptyBodyFile({ fullText: '' }), true);
    assert.equal(isEmptyBodyFile({ fullText: 'x'.repeat(399) }), true);
  });

  test('400+ char body is NOT empty-body', () => {
    assert.equal(isEmptyBodyFile({ fullText: 'x'.repeat(400) }), false);
  });

  test('aggregator stars or an assigned score count as non-empty (scoreable)', () => {
    assert.equal(isEmptyBodyFile({ fullText: '', aggregatorStars: 4 }), false);
    assert.equal(isEmptyBodyFile({ fullText: '', assignedScore: 80 }), false);
  });
});

describe('flagged-recovery: isRecoverableFlaggedFile', () => {
  test('1. empty-body in-window file IS recoverable', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '' }), true);
  });

  test('2. dead URL stops at the cap (3 tries)', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '', aggUrlRecoveryCount: 2 }), true);  // 3rd try allowed
    assert.equal(isRecoverableFlaggedFile({ fullText: '', aggUrlRecoveryCount: 3 }), false); // cap reached
    assert.equal(isRecoverableFlaggedFile({ fullText: '', aggUrlRecoveryCount: 9 }), false);
    assert.equal(FLAGGED_RECOVERY_CAP, 3);
  });

  test('3. wrongProduction / wrongShow file is NEVER recoverable (correct prior-production exclusion)', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongProduction: true }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongShow: true }), false);
  });

  test('4. human-protected file is NEVER recoverable', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: '', humanReviewScore: 75 }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongProductionManualClear: true }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', wrongShowManualClear: true }), false);
    assert.equal(isRecoverableFlaggedFile({ fullText: '', humanReviewedWrongProduction: false }), false);
  });

  test('a healed (full-body) file is not recoverable — nothing to do', () => {
    assert.equal(isRecoverableFlaggedFile({ fullText: 'x'.repeat(2000) }), false);
  });
});

describe('flagged-recovery: decideEmptyBodyRecovery', () => {
  test('recoverable empty-body → recover, carrying outlet/critic/url for same-slug merge', () => {
    const d = decideEmptyBodyRecovery({
      file: { fullText: '', aggUrlRecoveryCount: 0 },
      outletId: 'times-uk',
      critic: 'Clive Davis',
      url: AGG_URL,
    });
    assert.equal(d.action, 'recover');
    assert.equal(d.reason, 'empty-body-merge-safe');
    assert.equal(d.outletId, 'times-uk');
    assert.equal(d.critic, 'Clive Davis');
    assert.equal(d.url, AGG_URL);
  });

  test('missing aggregator URL → skip (nothing to re-fetch)', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: '' }, outletId: 'times-uk', url: null });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-aggregator-url');
  });

  test('cap reached → skip with cap-reached reason', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: '', aggUrlRecoveryCount: 3 }, url: AGG_URL });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'cap-reached');
  });

  test('wrongProduction → skip, reason names the exclusion (never re-fetched)', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: '', wrongProduction: true }, url: AGG_URL });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'wrong-production-or-show');
  });

  test('human-protected → skip (never touched)', () => {
    assert.equal(decideEmptyBodyRecovery({ file: { fullText: '', humanReviewScore: 80 }, url: AGG_URL }).reason, 'human-protected');
    assert.equal(decideEmptyBodyRecovery({ file: { fullText: '', wrongProductionManualClear: true }, url: AGG_URL }).reason, 'manual-clear');
    assert.equal(decideEmptyBodyRecovery({ file: { fullText: '', humanReviewedWrongProduction: false }, url: AGG_URL }).reason, 'human-verified-production');
  });

  test('full-body file → skip not-empty-body (no redundant re-fetch)', () => {
    const d = decideEmptyBodyRecovery({ file: { fullText: 'x'.repeat(2000) }, url: AGG_URL });
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'not-empty-body');
  });
});

describe('flagged-recovery: nextRecoveryCount (cap is persisted every attempt)', () => {
  test('monotonic increment from undefined / 0 / N', () => {
    assert.equal(nextRecoveryCount(undefined), 1);
    assert.equal(nextRecoveryCount({}), 1);
    assert.equal(nextRecoveryCount({ aggUrlRecoveryCount: 0 }), 1);
    assert.equal(nextRecoveryCount({ aggUrlRecoveryCount: 2 }), 3);
  });

  test('after CAP failed attempts the file is no longer recoverable', () => {
    // Simulate the loop: start empty, fail-fetch CAP times, bumping the counter each time.
    let file = { fullText: '' };
    for (let i = 0; i < FLAGGED_RECOVERY_CAP; i++) {
      assert.equal(isRecoverableFlaggedFile(file), true, `try ${i + 1} should still be recoverable`);
      file = { ...file, aggUrlRecoveryCount: nextRecoveryCount(file) };
    }
    assert.equal(isRecoverableFlaggedFile(file), false, 'after CAP tries it must stop');
    assert.equal(file.aggUrlRecoveryCount, FLAGGED_RECOVERY_CAP);
  });
});

// ── Trainspotting WE 2026-07-23 fixes (RC2 + RC3) ─────────────────────────────

describe('looksLikeReviewUrl: review-marker URL detection', () => {
  test('real review URLs match', () => {
    assert.equal(looksLikeReviewUrl('https://www.radiotimes.com/going-out/going-out-reviews/trainspotting-the-musical-review/'), true);
    assert.equal(looksLikeReviewUrl('https://www.theupcoming.co.uk/2026/07/23/trainspotting-the-musical-at-theatre-royal-haymarket-theatre-review/'), true);
    assert.equal(looksLikeReviewUrl('https://www.thestage.co.uk/reviews/trainspotting-the-musical-review-theatre-royal-haymarket'), true);
  });
  test('announcements / social posts do not match', () => {
    assert.equal(looksLikeReviewUrl('https://variety.com/2026/theater/global/trainspotting-the-musical-coming-london-west-end-1236697535/'), false);
    assert.equal(looksLikeReviewUrl('https://www.facebook.com/TELEGRAPH.CO.UK/posts/trainspotting-the-musical-opens-on-londons-west-end-this-month-featuring-no-punc/1481472537360707/'), false);
    assert.equal(looksLikeReviewUrl('https://www.westendtheatre.com/360185/news/trainspotting-the-musical-what-to-expect/'), false);
    assert.equal(looksLikeReviewUrl(null), false);
  });
  test('does not false-positive on words containing review', () => {
    assert.equal(looksLikeReviewUrl('https://example.com/previewing-the-season/'), false);
  });
});

describe('shouldSkipNonReviewStamp (RC2: Radio Times class)', () => {
  test('short ad-boilerplate body + review URL → skip the terminal stamp', () => {
    const d = { fullText: 'Find what to watch with Radio Times magazine. '.repeat(10).slice(0, 517), url: 'https://www.radiotimes.com/going-out/going-out-reviews/trainspotting-the-musical-review/' };
    assert.equal(shouldSkipNonReviewStamp(d), true);
  });
  test('substantive body → stamp allowed (real non-reviews stay flaggable)', () => {
    const d = { fullText: 'x'.repeat(2000), url: 'https://www.radiotimes.com/going-out/going-out-reviews/some-review/' };
    assert.equal(shouldSkipNonReviewStamp(d), false);
  });
  test('short body but non-review URL → stamp allowed (announcement pages)', () => {
    const d = { fullText: 'short', url: 'https://variety.com/2026/theater/global/show-coming-london-west-end-123/' };
    assert.equal(shouldSkipNonReviewStamp(d), false);
  });
});

describe('isRecoverableUncitedStub (RC3: The Upcoming class)', () => {
  const stub = () => ({ fullText: '', url: 'https://www.theupcoming.co.uk/2026/07/23/show-theatre-review/' });
  test('empty-body stub with its own review URL is retriable', () => {
    assert.equal(isRecoverableUncitedStub(stub()), true);
  });
  test('junk URLs never enter the retry pool', () => {
    assert.equal(isRecoverableUncitedStub({ fullText: '', url: 'https://www.facebook.com/x/posts/show-opens-this-month/123/' }), false);
    assert.equal(isRecoverableUncitedStub({ fullText: '' }), false);
  });
  test('protections: human / wrong-flags / dupes / roundups / cap', () => {
    assert.equal(isRecoverableUncitedStub({ ...stub(), humanReviewScore: 80 }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), wrongProduction: true }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), wrongShow: true }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), duplicateOf: 'other.json' }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), isRoundupArticle: true }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), aggUrlRecoveryCount: FLAGGED_RECOVERY_CAP }), false);
  });
  test('isNonReview on SHORT text does not strand the file; on long text it does', () => {
    assert.equal(isRecoverableUncitedStub({ ...stub(), isNonReview: true, fullText: 'ad boilerplate' }), true);
    assert.equal(isRecoverableUncitedStub({ ...stub(), isNonReview: true, fullText: 'x'.repeat(2000) }), false, 'long-text non-review is a trusted verdict (and not empty-body anyway)');
  });
  test('scored / starred / full files are not stubs', () => {
    assert.equal(isRecoverableUncitedStub({ ...stub(), aggregatorStars: '2/5' }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), assignedScore: 40 }), false);
    assert.equal(isRecoverableUncitedStub({ ...stub(), fullText: 'x'.repeat(500) }), false);
  });
});

describe('STAR_SOURCE_BY_REFERENCE (The Stage class star fallback)', () => {
  test('every mapped scoreSource is a known aggregator star source', () => {
    const { AGGREGATOR_SCORE_SOURCES } = require('../../scripts/lib/review-normalization.js');
    for (const src of Object.values(STAR_SOURCE_BY_REFERENCE)) {
      assert.equal(AGGREGATOR_SCORE_SOURCES.has(src), true, `${src} must be in AGGREGATOR_SCORE_SOURCES`);
    }
  });
});

describe('looksLikeReviewUrl: hardening from real-corpus scan (2026-07-23)', () => {
  test('social posts with review-y slugs are rejected', () => {
    assert.equal(looksLikeReviewUrl('https://www.facebook.com/BristolHippodrome/posts/heavenly-reviews-jesus-christ-superstar-has-opened/123/'), false);
    assert.equal(looksLikeReviewUrl('https://www.facebook.com/thestage/posts/-review-the-smile-of-her-american-actor/456/'), false);
  });
  test('relative / malformed URLs are rejected (not refetchable)', () => {
    assert.equal(looksLikeReviewUrl('/article/Review-MIDNIGHT-AT-THE-NEVER-GET-Menier-Chocolate-Factory-20260720'), false);
    assert.equal(looksLikeReviewUrl('not a url'), false);
  });
});

describe('isRecoverableUncitedStub: SERP-abandoned files stay out of the pool', () => {
  test('serpDiscoveryAbandoned blocks retry even with a review URL', () => {
    assert.equal(isRecoverableUncitedStub({ fullText: '', url: 'https://x.com/a-review/', serpDiscoveryAbandoned: true }), false);
    assert.equal(isRecoverableUncitedStub({ fullText: '', url: 'https://example.com/show-review/', serpDiscoveryAbandoned: true }), false);
  });
});

describe('filledDateOutsideWindow (post-fill guard, Tender/Sessions 2026-07-24)', () => {
  const req2 = createRequire(import.meta.url);
  const { filledDateOutsideWindow } = req2('../../scripts/lib/flagged-recovery.js');
  test('2021 review vs 2026 opening → outside', () => {
    assert.equal(filledDateOutsideWindow('2021-11-15', '2026-07-09'), true);
  });
  test('press-week review → inside', () => {
    assert.equal(filledDateOutsideWindow('2026-07-14', '2026-07-09'), false);
    assert.equal(filledDateOutsideWindow('2026-06-15', '2026-07-09'), false, '30d pre-opening previews window');
  });
  test('dateless or malformed fails open', () => {
    assert.equal(filledDateOutsideWindow(null, '2026-07-09'), false);
    assert.equal(filledDateOutsideWindow('2021-11-15', null), false);
    assert.equal(filledDateOutsideWindow('not-a-date', '2026-07-09'), false);
  });
});
