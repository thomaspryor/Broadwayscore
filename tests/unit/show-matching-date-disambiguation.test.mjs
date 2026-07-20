// Unit tests for scripts/lib/show-matching.js's options.date disambiguation.
// Regression coverage for the 2026-07-20 bug: matchTitleToShow() with no year/date
// hint always picked whichever same-title production is open TODAY, corrupting
// 2,351 show/week entries in a historical grosses backfill (250 shows affected).
// options.date (run-window containment, 14-day slack) is the fix; options.year
// (closest-opening-year) is the fallback when no window contains the date.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { matchTitleToShow } = require('../../scripts/lib/show-matching');

// Mirrors the real Gypsy production history (data/shows.json) that exposed the bug.
const GYPSY_PRODUCTIONS = [
  { id: 'gypsy-2024', slug: 'gypsy-2024', title: 'Gypsy', category: 'broadway', openingDate: '2024-12-19', closingDate: '2025-08-17', status: 'closed' },
  { id: 'gypsy-2008', slug: 'gypsy-2008', title: 'Gypsy', category: 'broadway', openingDate: '2008-03-27', closingDate: '2009-01-11', status: 'closed' },
  { id: 'gypsy-2003', slug: 'gypsy-2003', title: 'Gypsy', category: 'broadway', openingDate: '2003-05-01', closingDate: '2004-05-30', status: 'closed' },
  { id: 'gypsy-1989', slug: 'gypsy-1989', title: 'Gypsy', category: 'broadway', openingDate: '1989-11-16', closingDate: '1991-07-28', status: 'closed' },
  { id: 'gypsy-1974', slug: 'gypsy-1974', title: 'Gypsy', category: 'broadway', openingDate: '1974-09-23', closingDate: '1975-01-04', status: 'closed' },
];

// A still-open show has no closingDate — containment must treat that as "open-ended".
const OPEN_ENDED = [
  { id: 'chicago', slug: 'chicago', title: 'Chicago', category: 'broadway', openingDate: '1996-11-14', status: 'open' },
  { id: 'chicago-1975', slug: 'chicago-1975', title: 'Chicago', category: 'broadway', openingDate: '1975-06-03', closingDate: '1977-08-27', status: 'closed' },
];

describe('matchTitleToShow date-containment disambiguation', () => {
  it('resolves a historical week to the production actually running then, not the currently-open one', () => {
    const result = matchTitleToShow('Gypsy', GYPSY_PRODUCTIONS, { market: 'broadway', prefer: 'open', date: '2003-07-13' });
    assert.equal(result?.show?.id, 'gypsy-2003');
  });

  it('regression: without a date/year hint, falls back to whichever is open today (the original bug)', () => {
    const result = matchTitleToShow('Gypsy', GYPSY_PRODUCTIONS, { market: 'broadway', prefer: 'open' });
    assert.equal(result?.show?.id, 'gypsy-2024');
  });

  it('resolves each production correctly across its own run window', () => {
    const cases = [
      ['1990-01-15', 'gypsy-1989'],
      ['2008-10-01', 'gypsy-2008'],
      ['2025-01-01', 'gypsy-2024'],
    ];
    for (const [date, expectedId] of cases) {
      const result = matchTitleToShow('Gypsy', GYPSY_PRODUCTIONS, { market: 'broadway', prefer: 'open', date });
      assert.equal(result?.show?.id, expectedId, `date=${date}`);
    }
  });

  it('honors 14-day slack for a week just before an opening (previews)', () => {
    // gypsy-2003 opens 2003-05-01; a week 10 days prior should still resolve to it
    // over the far-away 2008 production, since no other candidate window contains it.
    const result = matchTitleToShow('Gypsy', GYPSY_PRODUCTIONS, { market: 'broadway', prefer: 'open', date: '2003-04-21' });
    assert.equal(result?.show?.id, 'gypsy-2003');
  });

  it('treats a missing closingDate as open-ended (still-running show)', () => {
    const result = matchTitleToShow('Chicago', OPEN_ENDED, { market: 'broadway', prefer: 'open', date: '2026-01-01' });
    assert.equal(result?.show?.id, 'chicago');
  });

  it('falls back to year-proximity when the date falls in a gap between two windows', () => {
    // 1980-01-01 is after gypsy-1974 closed and long before gypsy-1989 opened —
    // no window contains it, so closest-opening-year decides (1974 is closer than 1989).
    const result = matchTitleToShow('Gypsy', GYPSY_PRODUCTIONS, { market: 'broadway', prefer: 'open', date: '1980-01-01', year: 1980 });
    assert.equal(result?.show?.id, 'gypsy-1974');
  });
});
