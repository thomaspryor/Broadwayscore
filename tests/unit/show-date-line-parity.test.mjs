/**
 * Parity lock for the shared show-date-line module (task #951). The legacy
 * hero (src/app/show/[slug]/page.tsx) and ShowHeroRedesign.tsx used to each
 * encode their own start/closing/duration rules and drifted the same day a
 * fix landed in one and not the other. Both now consume
 * getShowDateLineSegments/formatDateLineString from src/lib/show-date-line —
 * this test locks the segment text so a future edit can't silently fork
 * behavior again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatShowDate,
  getShowDateLineSegments,
  formatDateLineString,
  getHeroDurationSuffix,
  getReviewAgeNote,
} from '../../src/lib/show-date-line';
import { readFileSync } from 'node:fs';

test('formatShowDate: hides invalid/pre-1950 input instead of echoing raw ISO', () => {
  assert.equal(formatShowDate(null), '');
  assert.equal(formatShowDate(undefined), '');
  assert.equal(formatShowDate('not-a-date'), '');
  assert.equal(formatShowDate('1899-01-01'), '');
  assert.equal(formatShowDate('2026-04-10'), 'Apr 10, 2026');
});

test('previews: openingDate present takes precedence over previewsStartDate', () => {
  const segs = getShowDateLineSegments({
    status: 'previews',
    openingDate: '2026-04-10',
    previewsStartDate: '2026-03-20',
    closingDate: null,
  });
  assert.equal(formatDateLineString(segs), 'Opens Apr 10, 2026');
});

test('previews: null openingDate falls back to previewsStartDate ("Previews from")', () => {
  const segs = getShowDateLineSegments({
    status: 'previews',
    openingDate: null,
    previewsStartDate: '2026-03-20',
    closingDate: '2026-06-01',
  });
  assert.equal(formatDateLineString(segs), 'Previews from Mar 20, 2026 · Closes Jun 1, 2026');
});

test('open: null openingDate falls back to previewsStartDate ("Running since") — the-magicians-table / amaze bug', () => {
  const segs = getShowDateLineSegments({
    status: 'open',
    openingDate: null,
    previewsStartDate: '2026-01-15',
    closingDate: null,
  });
  assert.equal(formatDateLineString(segs), 'Running since Jan 15, 2026');
});

test('open: null openingDate + closingDate still renders both halves', () => {
  const segs = getShowDateLineSegments({
    status: 'open',
    openingDate: null,
    previewsStartDate: '2026-01-15',
    closingDate: '2026-09-01',
  });
  assert.equal(formatDateLineString(segs), 'Running since Jan 15, 2026 · Closes Sep 1, 2026');
});

test('open: real openingDate, no closing — duration fragment when caller supplies one', () => {
  const segs = getShowDateLineSegments(
    { status: 'open', openingDate: '2020-01-01', previewsStartDate: null, closingDate: null },
    '5 years on Broadway'
  );
  assert.equal(formatDateLineString(segs), 'Opened Jan 1, 2020 · 5 years on Broadway');
});

test('closed: both start and closing known — Opened/Closed/Ran for', () => {
  const segs = getShowDateLineSegments({
    status: 'closed',
    openingDate: '2025-01-10',
    previewsStartDate: null,
    closingDate: '2025-07-10',
  });
  assert.equal(formatDateLineString(segs), 'Opened Jan 10, 2025 · Closed Jul 10, 2025 · Ran for 6 months');
});

test('closed: null openingDate falls back to previewsStartDate ("Ran from")', () => {
  const segs = getShowDateLineSegments({
    status: 'closed',
    openingDate: null,
    previewsStartDate: '2025-01-10',
    closingDate: '2025-07-10',
  });
  assert.equal(formatDateLineString(segs), 'Ran from Jan 10, 2025 · Closed Jul 10, 2025 · Ran for 6 months');
});

test('closed: only closingDate known', () => {
  const segs = getShowDateLineSegments({
    status: 'closed',
    openingDate: null,
    previewsStartDate: null,
    closingDate: '2025-07-10',
  });
  assert.equal(formatDateLineString(segs), 'Closed Jul 10, 2025');
});

test('closed: invalid closingDate never renders a dangling "Closed " label', () => {
  const segs = getShowDateLineSegments({
    status: 'closed',
    openingDate: '2025-01-10',
    previewsStartDate: null,
    closingDate: 'not-a-real-date',
  });
  assert.equal(formatDateLineString(segs), 'Ran from Jan 10, 2025');
});

test('open: invalid openingDate never renders a dangling "Opened " label', () => {
  const segs = getShowDateLineSegments({
    status: 'open',
    openingDate: '1899-01-01',
    previewsStartDate: null,
    closingDate: '2026-09-01',
  });
  assert.equal(formatDateLineString(segs), 'Closes Sep 1, 2026');
});

test('closed: no dates at all — empty segments, not a dangling line', () => {
  const segs = getShowDateLineSegments({ status: 'closed', openingDate: null, previewsStartDate: null, closingDate: null });
  assert.deepEqual(segs, []);
});

test('getHeroDurationSuffix: regional suppresses the duration fragment entirely', () => {
  assert.equal(getHeroDurationSuffix({ category: 'regional' }), null);
});

test('getHeroDurationSuffix: opera overrides category to "at the Met"', () => {
  assert.equal(getHeroDurationSuffix({ category: 'off-broadway', type: 'opera' }), 'at the Met');
});

test('emphasize flag marks the closing segment for the amber-highlight treatment', () => {
  const segs = getShowDateLineSegments({
    status: 'open',
    openingDate: '2026-01-01',
    previewsStartDate: null,
    closingDate: '2026-12-01',
  });
  const closing = segs.find((s) => s.kind === 'closing');
  assert.equal(closing.emphasize, true);
});

const NOW = new Date('2026-10-03T12:00:00Z');

test('getReviewAgeNote: long-running open show (Wicked-like) gets the caveat', () => {
  assert.equal(
    getReviewAgeNote({ status: 'open', openingDate: '2003-10-30' }, 25, NOW),
    'Most reviews from 23 years ago'
  );
});

test('getReviewAgeNote: exactly 10 years qualifies, 9 does not', () => {
  assert.equal(getReviewAgeNote({ status: 'open', openingDate: '2016-04-01' }, 5, NOW), 'Most reviews from 10 years ago');
  assert.equal(getReviewAgeNote({ status: 'open', openingDate: '2017-04-01' }, 5, NOW), null);
});

test('getReviewAgeNote: closed shows, thin review counts and missing/invalid dates get nothing', () => {
  assert.equal(getReviewAgeNote({ status: 'closed', openingDate: '2003-10-30' }, 25, NOW), null);
  assert.equal(getReviewAgeNote({ status: 'open', openingDate: '2003-10-30' }, 2, NOW), null);
  assert.equal(getReviewAgeNote({ status: 'open', openingDate: null }, 25, NOW), null);
  assert.equal(getReviewAgeNote({ status: 'open', openingDate: 'not-a-date' }, 25, NOW), null);
});

test('both heroes render the review-age caveat via the shared helper (redesign once dropped it)', () => {
  for (const file of ['src/app/show/[slug]/page.tsx', 'src/components/show-page/ShowHeroRedesign.tsx']) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(src, /getReviewAgeNote\(show, reviewCount\)/, `${file} must call getReviewAgeNote`);
    assert.doesNotMatch(src, /Most reviews from \{/, `${file} must not hand-roll the caveat text`);
  }
});
