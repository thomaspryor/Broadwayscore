/**
 * /box-office "This week" rows (BRO-5007 v3): the public table keeps open and
 * closed shows; the v3 table lists every show that reported in the market
 * week, previews included. Imports the real functions (§15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thisWeekRows } from '../../src/lib/box-office-this-week';
import { getBoxOfficeMarketPage } from '../../src/lib/data-commercial';
import { getBroadwayShows } from '../../src/lib/data-core';
import { getShowGrosses } from '../../src/lib/data-grosses';

const shows = [
  { slug: 'open', status: 'open' },
  { slug: 'previews', status: 'previews' },
  { slug: 'closed', status: 'closed' },
  { slug: 'dark', status: 'open' },
];
const g: Record<string, { thisWeek: { gross: number } | null }> = {
  open: { thisWeek: { gross: 1_000 } }, previews: { thisWeek: { gross: 2_000 } }, closed: { thisWeek: { gross: 500 } }, dark: { thisWeek: null },
};

test('thisWeekRows: public table keeps open and closed shows, highest gross first', () => {
  assert.deepEqual(thisWeekRows(shows, (s) => g[s]).map((r) => r.show.slug), ['open', 'closed']);
});

test('thisWeekRows: with the week\'s slugs, previews appear and a show without a gross does not', () => {
  const week = new Set(['open', 'previews', 'closed', 'dark']);
  assert.deepEqual(thisWeekRows(shows, (s) => g[s], week).map((r) => r.show.slug), ['previews', 'open', 'closed']);
});

test('real data: the v3 table has one row per show that reported this week', () => {
  const page = getBoxOfficeMarketPage();
  assert.ok(page, 'market page is null (stale inputs?)');
  const slugs = Object.keys(page.table);
  const rows = thisWeekRows(getBroadwayShows(), getShowGrosses, new Set(slugs));
  const missing = slugs.filter((s) => !rows.some((r) => r.show.slug === s));
  assert.deepEqual(missing, [], 'shows in the week but not in the table');
  assert.equal(rows.length, slugs.length);
  assert.ok(rows.length >= 20, `only ${rows.length} rows`);
});
