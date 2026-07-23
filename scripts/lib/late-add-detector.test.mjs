import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { detectLateAdd, GRACE_DAYS } = require('./late-add-detector.js');

describe('detectLateAdd', () => {
  test('no catalog clock -> not measurable', () => {
    const r = detectLateAdd([{ assignedScore: 80, publishDate: '2026-01-01', firstSeenAt: '2026-06-01' }], null);
    assert.equal(r.isLateAdd, false);
    assert.equal(r.reason, 'no-catalog-clock');
  });

  test('no reviews -> not measurable', () => {
    const r = detectLateAdd([], '2026-06-17');
    assert.equal(r.isLateAdd, false);
    assert.equal(r.reason, 'no-measurable-reviews');
  });

  test('unscored reviews are ignored', () => {
    const r = detectLateAdd([{ assignedScore: null, publishDate: '2026-01-01', firstSeenAt: '2026-06-01' }], '2026-06-17');
    assert.equal(r.reason, 'no-measurable-reviews');
  });

  test('a fetch-date-stamped publishDate (== firstSeenAt day, no source) is excluded as unmeasurable', () => {
    const r = detectLateAdd(
      [{ assignedScore: 80, publishDate: '2026-06-01', firstSeenAt: '2026-06-01T10:00:00Z' }],
      '2026-06-17',
    );
    assert.equal(r.reason, 'no-measurable-reviews');
  });

  test('review within the grace window is NOT a late add (normal preview review)', () => {
    // 20 days before previewsStartDate -- inside the 30d grace window.
    const r = detectLateAdd(
      [{ assignedScore: 82, publishDate: '2026-05-28', firstSeenAt: '2026-06-05T00:00:00Z', outletId: 'nytimes' }],
      '2026-06-17',
    );
    assert.equal(r.isLateAdd, false);
    assert.equal(r.gapDays, 20);
  });

  test('dad-dont-read-this class: earliest review ~35 days before catalog clock IS a late add', () => {
    // Real 2026-07-22 corpus shape: Vulture 2026-05-13, previewsStartDate 2026-06-17.
    const reviewsForShow = [
      { assignedScore: 78, publishDate: '2026-05-13', firstSeenAt: '2026-07-01T00:00:00Z', outletId: 'vulture' },
      { assignedScore: 89, publishDate: '2026-05-17', firstSeenAt: '2026-07-01T00:00:00Z', outletId: 'nytimes' },
      { assignedScore: 88, publishDate: '2026-06-23', firstSeenAt: '2026-06-24T00:00:00Z', outletId: 'nytg' },
    ];
    const r = detectLateAdd(reviewsForShow, '2026-06-17');
    assert.equal(r.isLateAdd, true);
    assert.equal(r.gapDays, 35);
    assert.equal(r.earliestReviewDate, '2026-05-13');
    assert.equal(r.earliestOutletId, 'vulture');
  });

  test('GRACE_DAYS boundary: exactly at the floor is NOT late (strictly greater-than)', () => {
    const catalogClock = '2026-06-17';
    const earliestMs = Date.parse(catalogClock) - GRACE_DAYS * 86400000;
    const earliestDate = new Date(earliestMs).toISOString().slice(0, 10);
    const r = detectLateAdd(
      [{ assignedScore: 80, publishDate: earliestDate, firstSeenAt: '2026-07-01T00:00:00Z' }],
      catalogClock,
    );
    assert.equal(r.isLateAdd, false);
    assert.equal(r.gapDays, GRACE_DAYS);
  });
});

describe('real corpus: dad-dont-read-this-off-broadway-2026 (if data available)', () => {
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
  const hasData = fs.existsSync(reviewsPath) && fs.existsSync(showsPath);

  test('is flagged as a late add on live data (S5-T1 acceptance criterion)', { skip: !hasData }, () => {
    const reviews = Object.values(JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews);
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
    const show = shows.find((s) => s.id === 'dad-dont-read-this-off-broadway-2026');
    assert.ok(show, 'fixture show still exists in the catalog');
    const showReviews = reviews.filter((r) => r.showId === show.id);
    const catalogClock = show.previewsStartDate || show.openingDate;
    const r = detectLateAdd(showReviews, catalogClock);
    assert.equal(r.isLateAdd, true, `expected a late-add flag, got: ${JSON.stringify(r)}`);
  });
});
