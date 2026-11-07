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
  getReviewAgeYear,
  getReviewPublishYears,
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
const dated = (...dates) => dates.map((publishDate) => ({ publishDate }));

test('getReviewPublishYears: reads ISO, year-month and prose dates; skips undated', () => {
  assert.deepEqual(
    getReviewPublishYears([
      { publishDate: '2003-10-31' },
      { publishDate: '2015-07' },
      { publishDate: 'November 20, 2025' },
      { publishDate: '' },
      { publishDate: null },
      {},
    ]),
    [2003, 2015, 2025]
  );
  assert.deepEqual(getReviewPublishYears(undefined), []);
});

test('getReviewAgeNote: long-running show reviewed at opening (Wicked-like) gets the caveat', () => {
  assert.equal(
    getReviewAgeNote({ status: 'open' }, dated('2003-10-31', '2003-10-31', '2003-11-01', '2004-01-10'), NOW),
    'Most reviews from 23 years ago'
  );
});

test('getReviewAgeNote: counts from review dates, not openingDate (Mousetrap West End re-entry)', () => {
  // the-mousetrap-west-end-2021 has openingDate 1952 but its reviews are from the
  // 2021 reopening; the old openingDate math said "74 years ago".
  assert.equal(getReviewAgeNote({ status: 'open' }, dated('2021-05-18', '2021-05-19', '2021-06-01'), NOW), null);
});

test('getReviewAgeNote: uses the year a majority of reviews were published by', () => {
  // 2 old + 2 recent: no majority is 10+ years old.
  assert.equal(getReviewAgeNote({ status: 'open' }, dated('1987-01-01', '1987-02-01', '2023-01-01', '2024-01-01'), NOW), null);
  // 3 old + 2 recent: majority from 1987.
  assert.equal(
    getReviewAgeNote({ status: 'open' }, dated('1987-01-01', '1987-02-01', '1988-03-01', '2023-01-01', '2024-01-01'), NOW),
    'Most reviews from 38 years ago'
  );
});

test('getReviewAgeNote: undated reviews are left out of the majority, not counted as recent', () => {
  // 3 dated (old) + 2 undated: the dated majority decides.
  assert.equal(
    getReviewAgeNote({ status: 'open' }, dated('2003-10-31', '2003-11-01', '2004-01-10', '', 'TBD'), NOW),
    'Most reviews from 23 years ago'
  );
});

test('getReviewAgeNote: exactly 10 years qualifies, 9 does not', () => {
  assert.equal(getReviewAgeNote({ status: 'open' }, dated('2016-04-01', '2016-04-02', '2016-04-03'), NOW), 'Most reviews from 10 years ago');
  assert.equal(getReviewAgeNote({ status: 'open' }, dated('2017-04-01', '2017-04-02', '2017-04-03'), NOW), null);
});

test('getReviewAgeNote: closed shows and fewer than 3 dated reviews get nothing', () => {
  const old = dated('2003-10-31', '2003-10-31', '2003-11-01');
  assert.equal(getReviewAgeNote({ status: 'closed' }, old, NOW), null);
  assert.equal(getReviewAgeNote({ status: 'open' }, dated('2003-10-31', '2003-10-31', '', 'n/a'), NOW), null);
  assert.equal(getReviewAgeNote({ status: 'open' }, [], NOW), null);
  assert.equal(getReviewAgeNote({ status: 'open' }, undefined, NOW), null);
});

test('both heroes render one shared review-age value (the redesign once dropped it)', () => {
  const page = readFileSync(new URL('../../src/app/show/[slug]/page.tsx', import.meta.url), 'utf8');
  const hero = readFileSync(new URL('../../src/components/show-page/ShowHeroRedesign.tsx', import.meta.url), 'utf8');
  // Computed once on the server, only for shows that display a critic score.
  assert.match(page, /const reviewAgeNote = showTBD \? null : getReviewAgeNote\(/);
  assert.match(page, /reviewAgeNote=\{reviewAgeNote\}/, 'page.tsx must pass the note to ShowHeroRedesign');
  assert.match(page, /\{reviewAgeNote &&/, 'legacy hero must render the shared note');
  assert.match(hero, /\{reviewAgeNote\}/, 'ShowHeroRedesign must render the note prop');
  for (const [file, src] of [['page.tsx', page], ['ShowHeroRedesign.tsx', hero]]) {
    assert.doesNotMatch(src, /Most reviews from \{/, `${file} must not hand-roll the caveat text`);
  }
  assert.doesNotMatch(hero, /getReviewAgeNote\(/, 'the redesign has no publishDate; it must use the prop');
});

test('getReviewAgeYear: the year behind the list-card note, same rule as the hero', () => {
  assert.equal(getReviewAgeYear({ status: 'open' }, dated('2003-10-31', '2003-10-31', '2003-11-01', '2004-01-10'), NOW), 2003);
  assert.equal(getReviewAgeYear({ status: 'open' }, dated('2021-05-18', '2021-05-19', '2021-06-01'), NOW), null);
  assert.equal(getReviewAgeYear({ status: 'closed' }, dated('2003-10-31', '2003-10-31', '2003-11-01'), NOW), null);
});

test('list cards use the shared review-age rule, not openingDate (Mousetrap card said "1952")', () => {
  const engine = readFileSync(new URL('../../src/lib/engine.ts', import.meta.url), 'utf8');
  assert.match(engine, /const reviewAgeYear = getReviewAgeYear\(\{ status: normalizedStatus \}, criticScore\?\.reviews\)/);
  assert.match(engine, /reviewYearNote = reviewAgeYear === null \? null : `Most reviews from \$\{reviewAgeYear\}`/);
  assert.doesNotMatch(engine, /openYear/, 'engine.ts must not count review age from openingDate');
});
