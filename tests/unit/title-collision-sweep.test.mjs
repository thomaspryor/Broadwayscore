// TESTS-VS-DERIVED-DATA-EXEMPT: real-data case is structural (siblings exist, window computed), pins no facts beyond ids

// BRO-30: title-keyed Reddit scrapes must not mix sibling productions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const {
  computeProductionWindow, isPostInProductionWindow, findTitleSiblings,
} = require('../../scripts/lib/production-window.js');

const SHOWS = new URL('../../data/shows.json', import.meta.url).pathname;
const sec = (d) => Date.parse(d) / 1000;
const bway = { id: 'glengarry-glen-ross-2025', title: 'Glengarry Glen Ross', category: 'broadway',
  previewsStartDate: '2025-03-10', openingDate: '2025-03-31', closingDate: '2025-06-28' };
const we = { id: 'glengarry-glen-ross-west-end-2026', title: 'Glengarry Glen Ross', category: 'west-end',
  previewsStartDate: '2026-06-04', openingDate: '2026-06-17', closingDate: '2026-07-18' };
const all = [bway, we, { id: 'other', title: 'Wicked', openingDate: '2003-10-30' }];

test('finds same-title siblings only', () => {
  assert.deepEqual(findTitleSiblings(we, all).map(s => s.id), [bway.id]);
  assert.deepEqual(findTitleSiblings(all[2], all), []);
});

test('2026 West End drops 2025 Culkin/Odenkirk-era posts', () => {
  const w = computeProductionWindow(we, all);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2025-04-15'), title: 'Glengarry with Culkin' }, we, w), false);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2026-06-20'), title: 'Glengarry Old Vic review' }, we, w), true);
});

test('2025 Broadway run drops posts after closing grace (later sibling chatter)', () => {
  const w = computeProductionWindow(bway, all);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2025-04-15'), title: 'Just saw Glengarry' }, bway, w), true);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2026-06-20'), title: 'Glengarry Old Vic' }, bway, w), false);
});

test('missing previewsStartDate falls back to opening-21d when siblings exist', () => {
  const noPrev = { ...we, previewsStartDate: null };
  const w = computeProductionWindow(noPrev, all);
  assert.ok(Math.abs(w.floorSec - (sec('2026-06-17') - 21 * 86400)) < 1);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2025-04-15'), title: 'x' }, noPrev, w), false);
});

test('long-running show keeps posts that mention an earlier revival year', () => {
  const rev = { id: 'dos-2012', title: 'Death of a Salesman', openingDate: '2012-03-15', previewsStartDate: '2012-02-29', closingDate: '2012-06-02' };
  const cur = { id: 'dos-2022', title: 'Death of a Salesman', openingDate: '2022-10-09', previewsStartDate: '2022-09-17' };
  const w = computeProductionWindow(cur, [rev, cur]);
  assert.equal(w.ceilSec, null);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2023-02-01'), title: 'Better than the 2012 revival?' }, cur, w), true);
});

test('fallback floor/ceiling only when an earlier/later sibling exists', () => {
  const first = { ...bway, previewsStartDate: null };
  const wf = computeProductionWindow(first, all); // sibling is LATER only
  assert.equal(wf.floorSec, null);
  assert.ok(wf.ceilSec != null);
  const later = { ...we, previewsStartDate: null };
  const wl = computeProductionWindow(later, all); // sibling is EARLIER only
  assert.ok(wl.floorSec != null);
  assert.equal(wl.ceilSec, null);
});

test('no-sibling shows are unchanged (no ceiling, no fallback floor)', () => {
  const solo = { id: 'h', title: 'Hamilton', openingDate: '2015-08-06', closingDate: '2030-01-01' };
  const w = computeProductionWindow(solo, all);
  assert.equal(w.floorSec, null);
  assert.equal(w.ceilSec, null);
  assert.equal(isPostInProductionWindow({ created_utc: sec('2020-01-01'), title: 'Hamilton 2019' }, solo, w), true);
});

test('real data: every 2025/2026 sibling pair gets a floor or ceiling', { skip: !fs.existsSync(SHOWS) }, () => {
  const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
  for (const id of ['glengarry-glen-ross-2025', 'glengarry-glen-ross-west-end-2026', 'beetlejuice-2025', 'beetlejuice-west-end-2026']) {
    const s = shows.find(x => x.id === id);
    if (!s) continue;
    const w = computeProductionWindow(s, shows);
    assert.ok(w.hasSiblings, id);
    assert.ok(w.floorSec != null || w.ceilSec != null, id);
  }
});
