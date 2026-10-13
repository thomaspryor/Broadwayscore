// BRO-901: visible "data may be stale" banner on the ticket-discovery pages.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STALENESS_THRESHOLD_DAYS,
  daysSinceUpdate,
  grossesAgeDays,
  staleDays,
  staleDaysFor,
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

describe('grosses age (measured from the week covered)', () => {
  // Local noon so the viewer-local calendar date is unambiguous in any TZ.
  const at = (d) => new Date(`${d}T12:00:00`).getTime();
  test('a re-scraped but unchanged week still ages', () => {
    // Scraper ran this morning, but the newest figures are for week ending Sep 27.
    assert.equal(grossesAgeDays(new Date(at('2026-10-13')).toISOString(), '9/27/2026', at('2026-10-13')), 16);
  });
  test('the scrape age wins when it is older', () => {
    assert.equal(grossesAgeDays(new Date(at('2026-09-01')).toISOString(), '10/4/2026', at('2026-10-13')), 42);
  });
  test('unparseable weekEnding falls back to the scrape age', () => {
    assert.equal(grossesAgeDays(new Date(at('2026-10-11')).toISOString(), 'soon', at('2026-10-13')), 2);
  });
  test('same rule as the build status gate: quiet through the Wed retry, stale on Thursday', () => {
    const scraped = new Date(at('2026-10-06')).toISOString(); // week ending Sun Oct 4, published Tue Oct 6
    assert.equal(staleDaysFor({ kind: 'grosses', lastUpdated: scraped, weekEnding: '10/4/2026' }, at('2026-10-14')), null); // Wed retry day, 10 days
    assert.equal(staleDaysFor({ kind: 'grosses', lastUpdated: scraped, weekEnding: '10/4/2026' }, at('2026-10-15')), 11); // both runs missed
  });
  test('ticket-policy feeds ignore weekEnding', () => {
    assert.equal(staleDaysFor({ kind: 'ticket-policies', lastUpdated: daysAgo(3), weekEnding: '1/1/2020' }, NOW), null);
  });
});

describe('copy', () => {
  test('ticket-policy copy names the age and the action', () => {
    const msg = stalenessMessage(9, 'ticket-policies');
    assert.match(msg, /^Heads up: this data was last refreshed 9 days ago\./);
    assert.match(msg, /double-check with the official platform before you go\.$/);
  });
  test('singular day', () => {
    assert.match(stalenessMessage(1, 'ticket-policies'), /1 day ago\./);
    assert.match(stalenessMessage(1, 'grosses'), /are 1 day old\./);
  });
  test('no em dashes in site copy', () => {
    for (const k of Object.keys(STALENESS_THRESHOLD_DAYS)) {
      assert.ok(!stalenessMessage(12, k).includes('—'), k);
    }
  });
});

test('banner and build status gate share one grosses threshold', async () => {
  const gate = await import('../../src/lib/box-office-status.ts');
  const week = await import('../../src/lib/grosses-week.ts');
  assert.equal(gate.MAX_GROSSES_AGE_DAYS, week.MAX_GROSSES_AGE_DAYS);
  assert.equal(STALENESS_THRESHOLD_DAYS.grosses, week.MAX_GROSSES_AGE_DAYS);
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

// Every page that shows a lottery/rush or grosses "Updated" date gets the
// banner. Found by scan, not a hand list, so a new page cannot miss it (the
// /best-value pages did on the first pass).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
function pagesUnder(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) pagesUnder(p, out);
    else if (n === 'page.tsx') out.push(p);
  }
  return out;
}
const FEED_DATE_RE = /\b(getLotteryRushLastUpdated|getGrossesLastUpdated)\(\)/;
const PAGES = pagesUnder('src/app')
  .filter((p) => FEED_DATE_RE.test(readFileSync(p, 'utf8')))
  .map((p) => [p.replace(/^src\/app\//, '').replace(/\/page\.tsx$/, ''), p.includes('/west-end/') ? 'west-end' : 'broadway']);

test('the scan finds the known ticket-discovery pages', () => {
  const names = PAGES.map(([p]) => p);
  for (const p of ['lotteries', 'rush', 'standing-room', 'discount-tickets', 'box-office', 'best-value', 'west-end/lotteries', 'west-end/best-value']) {
    assert.ok(names.includes(p), `scan missed ${p}`);
  }
});

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
    const src = readFileSync('src/app/box-office/page.tsx', 'utf8');
    assert.match(src, /<DataStalenessBanner[^>]*kind="grosses"/);
    // Measured from the covered week, not just the last scrape.
    assert.match(src, /<DataStalenessBanner[^>]*weekEnding=\{weekEnding\}/);
  });
});
