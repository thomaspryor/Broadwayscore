/**
 * Unit tests for scripts/lib/gather-review-stats.js's
 * shouldStampPreviewPlaceholder() (BRO-931 #3 follow-up — adversarial
 * ship-check finding on the isPreviewPlaceholder rebuild-exclusion fix).
 *
 * Before this fix, gather-reviews.js stamped isPreviewPlaceholder purely
 * from shows.json's status field ('previews') OR'd with a future openingDate.
 * Once review-guards.js's explainExclusion() started excluding
 * isPreviewPlaceholder files from rebuild (BRO-931 #3), a wrong stamp
 * became actively harmful: shows.json's status field lags reality
 * (update-show-status.yml runs once daily), so a show can sit at
 * status:'previews' for hours after it has genuinely opened — during which
 * a real, legitimate post-opening review would get wrongly excluded.
 *
 * Run: node --test scripts/lib/gather-review-stats.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldStampPreviewPlaceholder } = require('./gather-review-stats.js');

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

describe('shouldStampPreviewPlaceholder — basic cases', () => {
  it('status=previews, openingDate in the future → stamp', () => {
    assert.strictEqual(shouldStampPreviewPlaceholder({ status: 'previews', openingDate: FUTURE }), true);
  });

  it('status=open, openingDate in the past → do not stamp', () => {
    assert.strictEqual(shouldStampPreviewPlaceholder({ status: 'open', openingDate: PAST }), false);
  });

  it('status=previews, no openingDate at all → conservatively stamp', () => {
    assert.strictEqual(shouldStampPreviewPlaceholder({ status: 'previews' }), true);
  });

  it('no showMeta → do not stamp', () => {
    assert.strictEqual(shouldStampPreviewPlaceholder(null), false);
    assert.strictEqual(shouldStampPreviewPlaceholder(undefined), false);
  });
});

describe('shouldStampPreviewPlaceholder — status-lag self-heal (the bug this closes)', () => {
  it('status STILL "previews" but openingDate already passed → do NOT stamp (show genuinely opened)', () => {
    assert.strictEqual(
      shouldStampPreviewPlaceholder({ status: 'previews', openingDate: PAST }),
      false,
      'a stale status field must not override a passed openingDate — the show has genuinely opened'
    );
  });

  it('options.fromPostOpening=true always wins, even with status=previews and no openingDate', () => {
    assert.strictEqual(
      shouldStampPreviewPlaceholder({ status: 'previews' }, { fromPostOpening: true }),
      false,
      'an explicit caller assertion (the opening-night poller) must be trusted over shows.json'
    );
  });

  it('options.fromPostOpening=true wins even when openingDate is still in the future', () => {
    // Defensive: even in a shape that shouldn't happen (poller targeting a
    // not-yet-open show), an explicit caller assertion is honored — the
    // poller's own dispatch filter is what's responsible for not doing this.
    assert.strictEqual(
      shouldStampPreviewPlaceholder({ status: 'previews', openingDate: FUTURE }, { fromPostOpening: true }),
      false
    );
  });

  it('options.fromPostOpening=false (explicit) does NOT suppress stamping', () => {
    assert.strictEqual(
      shouldStampPreviewPlaceholder({ status: 'previews', openingDate: FUTURE }, { fromPostOpening: false }),
      true
    );
  });
});
