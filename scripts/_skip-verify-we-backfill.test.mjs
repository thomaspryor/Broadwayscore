// Acceptance recheck for the 2026-07-31 WE discovery fix (Notion card 3ae637c5416f81b0).
// NOT registered in test.yml — run standalone by autonomous-acceptance-recheck.js
// after RECHECK-AFTER passes. Reads LIVE repo data (verify-provider-spend-streak
// pattern), asserting the solo-performer-filter removal actually recovered the
// shows the filter was suppressing once the daily update-show-status cron ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = require('../data/shows.json');
const shows = data.shows || data;
const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const titles = new Set(shows.map((s) => norm(s.title)));

test('Space Dogs (Other Palace Studio) is in the catalog', () => {
  assert.ok(shows.some((s) => s.id === 'space-dogs-off-west-end-2026'));
});

test('solo-performer-filter removal recovered the suppressed WE shows', () => {
  // The 9 titles confirmed missing on 2026-07-31 purely because the removed
  // filter dropped them from TodayTix/londontheatre discovery. Sources churn,
  // so require a majority rather than all 9.
  const recovered = [
    'kimberly akimbo', 'jane eyre', 'twelfth night', 'nine night',
    'malory towers', 'la distance', 'hit machine', 'holy fool',
    'buffy revamped',
  ].filter((t) => titles.has(t));
  assert.ok(
    recovered.length >= 5,
    `only ${recovered.length}/9 recovered titles present: ${recovered.join(', ')}`
  );
});
