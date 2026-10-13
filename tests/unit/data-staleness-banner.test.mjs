// BRO-901: visible "data may be stale" banner on the ticket-discovery pages.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STALENESS_THRESHOLD_DAYS,
  daysSinceUpdate,
  staleDays,
  stalenessMessage,
} from '../../src/lib/data-staleness.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

describe('staleness decision', () => {
  test('fresh data shows no banner', () => {
    assert.equal(staleDays(daysAgo(1), 7, NOW), null);
  });
  test('exactly at the threshold is still fresh', () => {
    assert.equal(staleDays(daysAgo(7), 7, NOW), null);
  });
  test('past the threshold reports the age in days', () => {
    assert.equal(staleDays(daysAgo(8), 7, NOW), 8);
    assert.equal(staleDays(daysAgo(30), 7, NOW), 30);
  });
  test('missing or unparseable dates never invent an age', () => {
    assert.equal(staleDays(undefined, 7, NOW), null);
    assert.equal(staleDays('', 7, NOW), null);
    assert.equal(staleDays('not a date', 7, NOW), null);
    assert.equal(daysSinceUpdate('nope', NOW), null);
  });
  test('a timestamp in the future counts as fresh', () => {
    assert.equal(daysSinceUpdate(daysAgo(-2), NOW), 0);
  });
  test('thresholds sit above each feed\'s normal refresh gap', () => {
    // lottery/rush: Mon + Thu cron, max normal gap 4 days.
    assert.ok(STALENESS_THRESHOLD_DAYS['ticket-policies'] > 4);
    // grosses: weekly Tue with a Wed retry, normal gap up to ~8 days.
    assert.ok(STALENESS_THRESHOLD_DAYS.grosses > 8);
  });
});

describe('copy', () => {
  test('ticket-policy copy names the age and the action', () => {
    const msg = stalenessMessage(9, 'ticket-policies');
    assert.match(msg, /^Heads up: this data was last refreshed 9 days ago\./);
    assert.match(msg, /double-check with the official platform before you go\.$/);
  });
  test('singular day', () => {
    assert.match(stalenessMessage(1, 'grosses'), /1 day ago\./);
  });
  test('no em dashes in site copy', () => {
    for (const k of Object.keys(STALENESS_THRESHOLD_DAYS)) {
      assert.ok(!stalenessMessage(12, k).includes('—'), k);
    }
  });
});

describe('banner component', () => {
  const src = readFileSync('src/components/show-cards/DataStalenessBanner.tsx', 'utf8');
  test('uses the warning domain tokens, no custom amber/yellow', () => {
    assert.match(src, /bg-score-tepid-bg/);
    assert.match(src, /text-score-tepid/);
    assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:amber|yellow)-\d/);
  });
  test('is not dismissible', () => {
    assert.doesNotMatch(src, /onClick|onDismiss|setDismissed|localStorage/);
  });
  test('decides after mount only (static export; no hydration mismatch)', () => {
    assert.match(src, /useState<number \| null>\(null\)/);
    assert.match(src, /useEffect\(/);
  });
});

const PAGES = [
  ['lotteries', 'broadway'],
  ['rush', 'broadway'],
  ['standing-room', 'broadway'],
  ['discount-tickets', 'broadway'],
  ['box-office', 'broadway'],
  ['west-end/lotteries', 'west-end'],
  ['west-end/rush', 'west-end'],
  ['west-end/standing-room', 'west-end'],
  ['west-end/discount-tickets', 'west-end'],
];

describe('every ticket-discovery page renders the banner', () => {
  for (const [page, market] of PAGES) {
    test(page, () => {
      const src = readFileSync(`src/app/${page}/page.tsx`, 'utf8');
      const m = src.match(/<DataStalenessBanner\b[^>]*\/>/);
      assert.ok(m, `${page} has no <DataStalenessBanner />`);
      assert.match(m[0], /lastUpdated=\{lastUpdated\}/);
      assert.match(m[0], new RegExp(`market="${market}"`));
      // Above the fold: right under the title block, before the page body.
      const bannerAt = src.indexOf(m[0]);
      assert.ok(bannerAt > src.indexOf('<h1'), 'banner after the title');
      const nav = src.indexOf('<DiscountTicketsNav');
      if (nav !== -1) assert.ok(bannerAt < nav, 'banner before the page nav');
    });
  }
  test('box office uses the weekly-grosses threshold', () => {
    assert.match(readFileSync('src/app/box-office/page.tsx', 'utf8'), /<DataStalenessBanner[^>]*kind="grosses"/);
  });
});
