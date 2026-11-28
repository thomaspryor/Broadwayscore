// BRO-8456: stale tour segments. Real functions, no copied logic (CLAUDE.md 15).
// LIVE-DATA-LANE: reads data/shows.json (untracked core data) only for a consistency class guard (every open tour has a saved schedule); it pins no individual fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { statedClosedRanges, singleCompanyPath, segmentTourRows } = require('../../scripts/lib/tour-schedule.js');
const { latestEraSegment, layoffFor } = require('../../scripts/fetch-tour-schedules.js');
const { validateOverrides } = require('../../scripts/lib/tour-stop-overrides.js');

const d = s => new Date(`${s}T00:00:00Z`);
const row = (city, a, b) => ({ city, venue: 'V', start: d(a), end: d(b) });

test('History tab with years in the nested list closes And Juliet\'s 2024-2026 tour', () => {
  const html = '<li><span style="text-decoration: underline;">North American Tour</span><ul><li style="list-style-type: none;"><ul><li>2024–2026</li><li><strong>Union status</strong>: Equity</li></ul></li></ul></li>';
  assert.deepEqual(statedClosedRanges(html)[0], { from: 2024, to: 2026 });
});

test('nested History range ignores UK tours and open ranges', () => {
  assert.deepEqual(statedClosedRanges('<li><span>UK Tour</span><ul><li>2023–2024</li></ul></li>'), []);
  assert.deepEqual(statedClosedRanges('<li><span>North American Tour</span><ul><li>2024–</li></ul></li>'), []);
});

test('a 17-month pause is dropped at the default cutoff and kept with the tour\'s allowance', () => {
  const rows = [row('Minneapolis, MN', '2024-10-12', '2024-11-17'), row('Washington, DC', '2024-12-06', '2024-12-29'), row('Charleston, SC', '2026-06-03', '2026-06-07'), row('Princeton, NJ', '2026-08-19', '2026-08-30')];
  assert.equal(singleCompanyPath(rows, 365).kept.length, 2);
  const doc = JSON.parse(fs.readFileSync(new URL('../../data/tour-stop-overrides.json', import.meta.url), 'utf8'));
  const allow = layoffFor(doc.layoffAllowances, 'all-the-devils-are-here-how-shakespeare-invented-the-villain-tour-2024');
  assert.ok(allow > 365);
  assert.equal(singleCompanyPath(rows, allow).kept.length, 4);
  assert.equal(layoffFor(doc.layoffAllowances, 'some-other-tour'), undefined);
});

test('latestEraSegment: launch older than the page window takes the latest recent leg', () => {
  const segs = segmentTourRows([
    row('A', '2021-12-01', '2021-12-05'), row('B', '2021-12-07', '2021-12-12'),
    row('C', '2025-10-02', '2025-10-08'), row('D', '2025-10-10', '2026-10-10'),
  ]);
  const now = d('2026-11-28');
  const hit = latestEraSegment(segs, { openingDate: '2018-12-20' }, now);
  assert.equal(hit.rows.length, 2);
  assert.equal(latestEraSegment(segs, { openingDate: '2018-12-20', closingDate: '2026-10-10' }, now), null, 'closed tours never');
  assert.equal(latestEraSegment(segs, { openingDate: '2022-01-01' }, now), null, 'launch inside the page window uses pickSegment');
  assert.equal(latestEraSegment(segs, { openingDate: '2018-12-20' }, d('2027-06-01')), null, 'a leg over for 120+ days is not current');
});

test('shipped overrides file (incl. layoffAllowances) validates; bad allowance rejected', () => {
  const doc = JSON.parse(fs.readFileSync(new URL('../../data/tour-stop-overrides.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateOverrides(doc), []);
  assert.ok(validateOverrides({ overrides: [], layoffAllowances: [{ tourId: 't', maxLayoffDays: 100, reason: 'x' }] }).length);
});

test('class guard: no open tour is left without any saved schedule', () => {
  const shows = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8')).shows;
  const ts = JSON.parse(fs.readFileSync(new URL('../../data/tour-schedules.json', import.meta.url), 'utf8')).tours;
  const bad = shows.filter(s => s.category === 'tour' && s.status !== 'closed' && s.openingDate && s.openingDate < '2026-10-01' && !((ts[s.id] || {}).stops || []).length).map(s => s.id);
  assert.deepEqual(bad, [], 'open tour with no schedule: see latestEraSegment / fetch-tour-schedules --show=ID');
});

test('a pilcrow footnote mark does not hide a stop date (Devils: "January 15-25, 2026 ¶")', () => {
  const { parseDateRange } = require('../../scripts/lib/tour-schedule.js');
  const a = parseDateRange('January 15-25, 2026 ¶');
  assert.ok(a && a.start && a.end, 'parsed');
  assert.equal(a.start.toISOString().slice(0, 10), '2026-01-15');
});

test('latestEraTours: the fallback applies only to a listed tour, never to a bare old launch (tour-schedule-now-next guard)', () => {
  const { tourStops } = require('../../scripts/fetch-tour-schedules.js');
  const { validateOverrides } = require('../../scripts/lib/tour-stop-overrides.js');
  const row = (c, v, d) => `<tr><td>${c}</td><td>${v}</td><td>${d}</td></tr>`;
  const html = `<table>${[row('Fayetteville, AR', 'Walton Arts Center', 'August 16-25, 2024'), row('Tulsa, OK', 'Tulsa PAC', 'August 27-September 8, 2024')].join('')}</table>`;
  const now = new Date('2024-10-05T00:00:00Z');
  const tour = { id: 'x-tour-2019', openingDate: '2019-06-01' };
  assert.equal(tourStops(tour, html, now), null, 'default: an old tour takes no new company schedule');
  assert.ok(tourStops(tour, html, now, { latestEra: true }), 'listed tour takes its latest leg');
  const doc = JSON.parse(fs.readFileSync(new URL('../../data/tour-stop-overrides.json', import.meta.url), 'utf8'));
  assert.ok((doc.latestEraTours || []).some(t => t.tourId === 'spamilton-an-american-parody-tour-2018'));
  assert.deepEqual(validateOverrides(doc), []);
  assert.ok(validateOverrides({ overrides: [], latestEraTours: [{ tourId: 't' }] }).length);
});
