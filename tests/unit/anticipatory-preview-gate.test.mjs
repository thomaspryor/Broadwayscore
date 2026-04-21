/**
 * Unit tests for isAnticipatoryPreviewPost
 * (scripts/lib/content-filters.js — Schmigadoon 2026 Bug #5).
 *
 * Background: For Schmigadoon's 2026-04-20 opening, a frontmezzjunkies
 * post published 2026-04-04 (16 days pre-opening) was treated as a
 * review and scored 76. frontmezzjunkies routinely publishes "anticipation"
 * pieces pre-opening — well-written, excited, but not reviews.
 *
 * This gate fires INSIDE collect-review-texts.js/updateReviewJson right
 * after publishDate extraction, BEFORE the file is written. A miss here =
 * an anticipatory preview piece reaching reviews.json as a scored review.
 *
 * Mirrors semantics of the post-broadcast audit check at
 * scripts/lib/opening-night-checks/publish-date-pre-opening.check.js
 * (GRACE_DAYS_BEFORE_OPENING = 2 for default outlets).
 *
 * Preview-heavy outlets use a tighter 0-day grace: must publish on or
 * after openingDate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isAnticipatoryPreviewPost,
  PREVIEW_HEAVY_OUTLETS,
  DEFAULT_GRACE_DAYS_BEFORE_OPENING,
  PREVIEW_HEAVY_GRACE_DAYS,
} = require('../../scripts/lib/content-filters.js');

describe('PREVIEW_HEAVY_OUTLETS catalogue integrity', () => {
  test('includes frontmezzjunkies (Schmigadoon 2026 incident)', () => {
    assert.ok(PREVIEW_HEAVY_OUTLETS.has('frontmezzjunkies'));
  });

  test('includes Broadway Direct (both spellings)', () => {
    assert.ok(PREVIEW_HEAVY_OUTLETS.has('broadwaydirect'));
    assert.ok(PREVIEW_HEAVY_OUTLETS.has('broadway-direct'));
  });

  test('does NOT include T1 news outlets (legitimate embargo-lift coverage)', () => {
    for (const t1 of ['nyt', 'variety', 'hollywoodreporter', 'vulture', 'wsj']) {
      assert.ok(!PREVIEW_HEAVY_OUTLETS.has(t1), `T1 outlet "${t1}" should not be preview-heavy`);
    }
  });

  test('default grace is 2 days; preview-heavy grace is 0', () => {
    assert.strictEqual(DEFAULT_GRACE_DAYS_BEFORE_OPENING, 2);
    assert.strictEqual(PREVIEW_HEAVY_GRACE_DAYS, 0);
  });
});

describe('isAnticipatoryPreviewPost — Schmigadoon 2026 regression', () => {
  test('frontmezzjunkies 16 days before opening → rejected', () => {
    const r = isAnticipatoryPreviewPost('2026-04-04', '2026-04-20', 'frontmezzjunkies');
    assert.strictEqual(r.rejected, true);
    assert.strictEqual(r.outletCategory, 'preview-heavy');
    assert.strictEqual(r.daysBeforeOpening, 16);
    assert.match(r.reason, /preview-heavy/);
  });

  test('humanReviewedEarlyPublish=true bypasses the gate (curator override)', () => {
    const r = isAnticipatoryPreviewPost('2026-04-04', '2026-04-20', 'frontmezzjunkies', {
      humanReviewedEarlyPublish: true,
    });
    assert.strictEqual(r.rejected, false);
  });
});

describe('isAnticipatoryPreviewPost — preview-heavy outlets (0-day grace)', () => {
  test('frontmezzjunkies 1 day before opening → rejected', () => {
    const r = isAnticipatoryPreviewPost('2026-04-19', '2026-04-20', 'frontmezzjunkies');
    assert.strictEqual(r.rejected, true);
    assert.strictEqual(r.outletCategory, 'preview-heavy');
  });

  test('frontmezzjunkies exactly on opening day → passes', () => {
    const r = isAnticipatoryPreviewPost('2026-04-20', '2026-04-20', 'frontmezzjunkies');
    assert.strictEqual(r.rejected, false);
  });

  test('frontmezzjunkies 1 day after opening → passes', () => {
    const r = isAnticipatoryPreviewPost('2026-04-21', '2026-04-20', 'frontmezzjunkies');
    assert.strictEqual(r.rejected, false);
  });

  test('broadwaydirect 5 days before opening → rejected', () => {
    const r = isAnticipatoryPreviewPost('2026-04-15', '2026-04-20', 'broadwaydirect');
    assert.strictEqual(r.rejected, true);
    assert.strictEqual(r.outletCategory, 'preview-heavy');
  });

  test('broadway-direct alias also rejected', () => {
    const r = isAnticipatoryPreviewPost('2026-04-15', '2026-04-20', 'broadway-direct');
    assert.strictEqual(r.rejected, true);
  });

  test('outlet id is case-insensitive', () => {
    const r = isAnticipatoryPreviewPost('2026-04-04', '2026-04-20', 'FrontMezzJunkies');
    assert.strictEqual(r.rejected, true);
    assert.strictEqual(r.outletCategory, 'preview-heavy');
  });
});

describe('isAnticipatoryPreviewPost — non-preview outlets (2-day grace)', () => {
  test('NYT 2 days before opening → passes (within default grace)', () => {
    const r = isAnticipatoryPreviewPost('2026-04-18', '2026-04-20', 'nyt');
    assert.strictEqual(r.rejected, false);
  });

  test('NYT 3 days before opening → rejected (exceeds 2-day grace)', () => {
    const r = isAnticipatoryPreviewPost('2026-04-17', '2026-04-20', 'nyt');
    assert.strictEqual(r.rejected, true);
    assert.strictEqual(r.outletCategory, 'default');
    assert.strictEqual(r.daysBeforeOpening, 3);
  });

  test('Variety on opening day → passes', () => {
    const r = isAnticipatoryPreviewPost('2026-04-20', '2026-04-20', 'variety');
    assert.strictEqual(r.rejected, false);
  });

  test('retrospective review (historical show, publishDate = openingDate) → passes', () => {
    const r = isAnticipatoryPreviewPost('2015-08-06', '2015-08-06', 'nyt');
    assert.strictEqual(r.rejected, false);
  });

  test('post-opening NYT review → passes', () => {
    const r = isAnticipatoryPreviewPost('2026-04-25', '2026-04-20', 'nyt');
    assert.strictEqual(r.rejected, false);
  });
});

describe('isAnticipatoryPreviewPost — opts.graceDays overrides', () => {
  test('opts.graceDays overrides default for non-preview outlet', () => {
    // With graceDays=7, a 5-day-before review passes that would otherwise be rejected
    const r = isAnticipatoryPreviewPost('2026-04-15', '2026-04-20', 'nyt', { graceDays: 7 });
    assert.strictEqual(r.rejected, false);
  });

  test('opts.gracePreviewHeavyOutlet overrides for preview-heavy outlet', () => {
    // With gracePreviewHeavyOutlet=10, a 5-day frontmezz review passes
    const r = isAnticipatoryPreviewPost('2026-04-15', '2026-04-20', 'frontmezzjunkies', {
      gracePreviewHeavyOutlet: 10,
    });
    assert.strictEqual(r.rejected, false);
  });
});

describe('isAnticipatoryPreviewPost — fail-safe defaults', () => {
  test('null publishDate → fail-open (not rejected)', () => {
    const r = isAnticipatoryPreviewPost(null, '2026-04-20', 'frontmezzjunkies');
    assert.strictEqual(r.rejected, false);
  });

  test('null openingDate → fail-open', () => {
    const r = isAnticipatoryPreviewPost('2026-04-04', null, 'frontmezzjunkies');
    assert.strictEqual(r.rejected, false);
  });

  test('invalid date string → fail-open', () => {
    const r = isAnticipatoryPreviewPost('not-a-date', '2026-04-20', 'frontmezzjunkies');
    assert.strictEqual(r.rejected, false);
  });

  test('null outletId → defaults to non-preview grace', () => {
    const r = isAnticipatoryPreviewPost('2026-04-18', '2026-04-20', null);
    assert.strictEqual(r.rejected, false); // within 2-day grace
    const r2 = isAnticipatoryPreviewPost('2026-04-17', '2026-04-20', null);
    assert.strictEqual(r2.rejected, true); // exceeds 2-day grace
    assert.strictEqual(r2.outletCategory, 'default');
  });

  test('empty opts object behaves as defaults', () => {
    const r = isAnticipatoryPreviewPost('2026-04-04', '2026-04-20', 'frontmezzjunkies', {});
    assert.strictEqual(r.rejected, true);
  });
});
