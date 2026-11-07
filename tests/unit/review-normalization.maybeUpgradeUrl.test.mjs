/**
 * BRO-111: URL-change invariant gap — stale wrongProduction/contentVerification
 * surviving maybeUpgradeUrl() (review-normalization.js).
 *
 * maybeUpgradeUrl() already routes every genuine URL upgrade through
 * applyUrlChangeInvariant(..., { force: true }) (see #483, closed by
 * 16c834c9bf4 / task #1695), which clears URL_DERIVED_FIELDS — including
 * wrongProduction, wrongProductionNote, and contentVerification — whenever a
 * bad-content file's URL is replaced with a new one. This test locks that
 * behavior in directly against maybeUpgradeUrl (not just its
 * createOrMergeReviewFile caller, covered by
 * review-file-writer-preserves-flags-on-url-change.test.mjs).
 *
 * It also guards the deliberate exception: when contentTier === 'invalid'
 * AND a wrongProduction/wrongShow/duplicateOf flag is present, the flag is
 * flag-driven (content-quality.js's T5 check), not a genuine content-quality
 * signal. Two independent hand adjudications (20/20, 8/8) found those specific
 * flags correctly set, not stale — auto-clearing them previously drained 121
 * files and reddened CI (see scripts/lib/stale-flag-after-url-correction.js).
 * maybeUpgradeUrl refuses the swap entirely in that case, so this test also
 * pins that refusal so it isn't accidentally loosened back into an auto-clear.
 *
 * Run: node --test tests/unit/review-normalization.maybeUpgradeUrl.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { maybeUpgradeUrl } = require('../../scripts/lib/review-normalization.js');

const quiet = (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = w; }
};

function staleFlaggedFile(overrides = {}) {
  return {
    showId: 'test-show',
    outletId: 'vulture',
    criticName: 'Jesse Green',
    url: 'https://www.vulture.com/test-show-old-review',
    fullText: '',
    contentTier: 'stub',
    wrongProduction: true,
    wrongProductionNote: 'Some unrelated auto-guard note about the old article',
    contentVerification: { verified: false, reason: 'old article mismatch' },
    ...overrides,
  };
}

describe('maybeUpgradeUrl clears stale wrongProduction/contentVerification on a genuine URL upgrade (BRO-111)', () => {
  test('wrongProduction + contentVerification carried from the old URL are cleared', () => {
    const existing = staleFlaggedFile();
    const changed = quiet(() => maybeUpgradeUrl(
      existing,
      'https://www.vulture.com/test-show-new-review',
      'bww-aggregator',
      { showTitle: 'Test Show' },
    ));

    assert.equal(changed, true);
    assert.equal(existing.url, 'https://www.vulture.com/test-show-new-review');
    assert.equal(existing.wrongProduction, undefined, 'stale wrongProduction must not survive the URL correction');
    assert.equal(existing.wrongProductionNote, undefined, 'stale wrongProductionNote must not survive the URL correction');
    assert.equal(existing.contentVerification, undefined, 'stale contentVerification must not survive the URL correction');
    assert.equal(existing.needsRefetch, true, 'refetch must be triggered for the new URL');
    assert.equal(existing.urlCorrectedFrom, 'https://www.vulture.com/test-show-old-review');
    assert.ok(existing._urlChangedClear, 'breadcrumb must record the clear so CI restore machinery does not resurrect it');
    assert.ok(existing._urlChangedClear.cleared.includes('wrongProduction'));
    assert.ok(existing._urlChangedClear.cleared.includes('contentVerification'));
  });

  test('wrongShow carried from the old URL is cleared alongside contentVerification', () => {
    const existing = staleFlaggedFile({
      wrongProduction: undefined,
      wrongProductionNote: undefined,
      wrongShow: true,
      wrongShowReason: 'Old article was about a different show entirely',
    });
    const changed = quiet(() => maybeUpgradeUrl(
      existing,
      'https://www.vulture.com/test-show-new-review',
      'bww-aggregator',
      { showTitle: 'Test Show' },
    ));

    assert.equal(changed, true);
    assert.equal(existing.wrongShow, undefined);
    assert.equal(existing.wrongShowReason, undefined);
    assert.equal(existing.contentVerification, undefined);
  });

  test('manual wrongProductionManualClear / urlManualOverride still blocks the swap outright', () => {
    const existing = staleFlaggedFile({ urlManualOverride: true });
    const changed = quiet(() => maybeUpgradeUrl(
      existing,
      'https://www.vulture.com/test-show-new-review',
      'bww-aggregator',
      { showTitle: 'Test Show' },
    ));

    assert.equal(changed, false, 'a manually-verified URL must never be silently swapped');
    assert.equal(existing.url, 'https://www.vulture.com/test-show-old-review');
    assert.equal(existing.wrongProduction, true);
  });

  test('a cosmetic-only URL variant (same canonical article, e.g. a tracking param) still clears stale flags via force:true (#483)', () => {
    // normalizeUrl() treats these as the SAME article — urlCanonicallyChanged()
    // alone would say nothing changed. maybeUpgradeUrl already decided the old
    // content is bad and is discarding it regardless, so it must still fire
    // the invariant here; this is the exact escape maybeUpgradeUrl's force:true
    // option exists to close (see url-change-invariant.js's `force` doc).
    const existing = staleFlaggedFile();
    const cosmeticVariant = existing.url + '?utm_source=twitter';
    const changed = quiet(() => maybeUpgradeUrl(
      existing,
      cosmeticVariant,
      'bww-aggregator',
      { showTitle: 'Test Show' },
    ));

    assert.equal(changed, true);
    assert.equal(existing.wrongProduction, undefined, 'stale wrongProduction must clear even on a cosmetic-only URL variant');
    assert.equal(existing.contentVerification, undefined, 'stale contentVerification must clear even on a cosmetic-only URL variant');
  });

  test('contentTier:invalid + wrongProduction refuses the swap entirely (flag-driven, not stale — do not auto-clear)', () => {
    const existing = staleFlaggedFile({ contentTier: 'invalid', contentTierReason: 'Wrong production' });
    const before = { ...existing };
    const changed = quiet(() => maybeUpgradeUrl(
      existing,
      'https://www.vulture.com/test-show-new-review',
      'bww-aggregator',
      { showTitle: 'Test Show' },
    ));

    assert.equal(changed, false, 'contentTier:invalid is flag-driven — the swap must be refused, not silently upgraded');
    assert.deepEqual(existing, before, 'refused swap must leave the record untouched');
  });
});
