import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { getFlaggedOutlets } = require(path.join(__dirname, '../../scripts/monitor-outlet-recency.js'));

const OUTLETS = {
  nytimes: { tier: 1, name: 'The New York Times' },
  nypost: { tier: 2, name: 'New York Post' },
  someblog: { tier: 3, name: 'Some Blog' }, // T3 — excluded by maxTier
};

const SHOW_CATEGORY = { 'show-a': 'broadway', 'show-b': 'broadway' };

function review({ outletId, showId, publishDate }) {
  return { outletId, showId, publishDate, assignedScore: 80 };
}

describe('monitor-outlet-recency: getFlaggedOutlets', () => {
  test('flags a T1/T2 outlet silent 60+ days beyond its own cadence', () => {
    // nytimes reviews every ~5 days, most recently "today" (2026-07-27) — sets
    // the broadway market pulse. nypost reviewed regularly through April, then
    // went silent — 60+ days past the market pulse with a tight historical
    // cadence (~5d median), so it's red by a wide margin (>30d either way).
    const reviews = [];
    // Market pulse (T1) — dense recent nytimes cadence.
    const nytDates = ['2026-07-27', '2026-07-22', '2026-07-17', '2026-07-12', '2026-07-07', '2026-07-02'];
    for (const d of nytDates) reviews.push(review({ outletId: 'nytimes', showId: 'show-a', publishDate: d }));

    // nypost: regular ~5-day cadence through April, then nothing since.
    const nypostDates = ['2026-04-27', '2026-04-22', '2026-04-17', '2026-04-12', '2026-04-07'];
    for (const d of nypostDates) reviews.push(review({ outletId: 'nypost', showId: 'show-b', publishDate: d }));

    const flagged = getFlaggedOutlets(reviews, OUTLETS, SHOW_CATEGORY, { nowMs: Date.parse('2026-07-27') });

    const nypostRow = flagged.find((r) => r.outletId === 'nypost');
    assert.ok(nypostRow, 'nypost should be flagged red');
    assert.equal(nypostRow.status, 'red');
    assert.ok(nypostRow.silentDays > 30, `expected >30d silent, got ${nypostRow.silentDays}`);
  });

  test('does not flag an outlet whose silence is within its own cadence (Broadway lull, not a gap)', () => {
    const reviews = [];
    const nytDates = ['2026-07-27', '2026-07-22', '2026-07-17', '2026-07-12', '2026-07-07', '2026-07-02'];
    for (const d of nytDates) reviews.push(review({ outletId: 'nytimes', showId: 'show-a', publishDate: d }));
    // Healthy T2 outlet: only reviews every ~45 days historically, last one 20 days ago — well within cadence.
    const healthyDates = ['2026-07-07', '2026-05-23', '2026-04-08'];
    for (const d of healthyDates) reviews.push(review({ outletId: 'nypost', showId: 'show-b', publishDate: d }));

    const flagged = getFlaggedOutlets(reviews, OUTLETS, SHOW_CATEGORY, { nowMs: Date.parse('2026-07-27') });
    assert.ok(!flagged.find((r) => r.outletId === 'nypost'), 'nypost should not be flagged while within its own cadence');
  });

  test('excludes T3+ outlets (maxTier)', () => {
    const reviews = [];
    const nytDates = ['2026-07-27', '2026-07-22', '2026-07-17', '2026-07-12', '2026-07-07', '2026-07-02'];
    for (const d of nytDates) reviews.push(review({ outletId: 'nytimes', showId: 'show-a', publishDate: d }));
    const blogDates = ['2026-04-01', '2026-03-27', '2026-03-22'];
    for (const d of blogDates) reviews.push(review({ outletId: 'someblog', showId: 'show-b', publishDate: d }));

    const flagged = getFlaggedOutlets(reviews, OUTLETS, SHOW_CATEGORY, { nowMs: Date.parse('2026-07-27') });
    assert.ok(!flagged.find((r) => r.outletId === 'someblog'), 'T3 outlets are out of scope (maxTier=2)');
  });
});
