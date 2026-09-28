import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDateRange, parseTourSchedule, segmentTourRows, decideTourDates, statedClosedRanges, scheduleSlugs } = require('./tour-schedule.js');

const iso = d => d.toISOString().slice(0, 10);
const row = (city, venue, dates) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td><td>2024-2025</td></tr>`;
const page = (rows, notes = '') => `<html><body><p>${notes}</p><table><tr><th>Location</th><th>Venue</th><th>Dates</th><th>Season</th></tr>${rows.join('')}</table></body></html>`;
const NOW = new Date('2026-09-28T00:00:00Z');

test('parseDateRange handles the formats on the site', () => {
  const r = (s) => { const x = parseDateRange(s); return x && [iso(x.start), iso(x.end)]; };
  assert.deepEqual(r('December 1, 2022'), ['2022-12-01', '2022-12-01']);
  assert.deepEqual(r('June 22-24, 2027'), ['2027-06-22', '2027-06-24']);
  assert.deepEqual(r('October 29–November 3, 2024'), ['2024-10-29', '2024-11-03']);
  assert.deepEqual(r('December 30, 2025&#8211;January 4, 2026'), ['2025-12-30', '2026-01-04']);
  assert.equal(r('TBA'), null);
});

test('rescheduled rows are skipped; New York runs split tours', () => {
  const html = page([
    row('Minneapolis, MN', 'Orpheum', 'September 13-18, 2022&nbsp;♦'),
    row('Paducah, KY', 'Carson Center', 'December 1, 2022'),
    row('Chicago, IL', 'Nederlander', 'December 6-18, 2022'),
    row('Charlotte, NC', 'Belk', 'September 9-14, 2025'),
    row('New York, NY', 'Palace Theatre', 'October 8, 2025–January 3, 2026'),
    row('Fresno, CA', 'Saroyan', 'February 13, 2026'),
    row('Sacramento, CA', 'Memorial', 'February 17-22, 2026'),
  ]);
  const rows = parseTourSchedule(html);
  assert.equal(rows.length, 6, 'the ♦ row is dropped');
  // Chicago to Charlotte is a long gap in this toy page, so it's its own segment; the point is NY never joins one.
  const segs = segmentTourRows(rows);
  assert.ok(segs.every(s => s.rows.every(r => !/New York/.test(r.city))));
  assert.equal(iso(segs[segs.length - 1].start), '2026-02-13');
});

test('launch needs Wikipedia; close needs a positive signal', () => {
  const html = page([
    row('Baltimore, MD', 'Hippodrome', 'December 7-14, 2024'),
    row('Washington, DC', 'Kennedy Center', 'December 17, 2024–January 5, 2025'),
    row('Fort Lauderdale, FL', 'Broward Center', 'January 21-26, 2025'),
  ]);
  const tour = { id: 'x-tour-2024', title: 'X', openingDate: null, closingDate: null };
  assert.deepEqual(decideTourDates(tour, html, '', NOW).write, {}, 'no Wikipedia, no stated range: write nothing');
  assert.deepEqual(decideTourDates(tour, html, 'began on December 7, 2024 in Baltimore', NOW).write, { openingDate: '2024-12-07' });
  assert.deepEqual(
    decideTourDates(tour, html, 'began on December 7, 2024 ... closed on January 26, 2025', NOW).write,
    { openingDate: '2024-12-07', closingDate: '2025-01-26' },
  );
  const stated = html.replace('<p></p>', '<p>North American Tour (2024–2025)</p>');
  assert.equal(decideTourDates({ ...tour, openingDate: '2024-12-07' }, stated, '', NOW).write.closingDate, '2025-01-26');
});

test('silence never closes: an empty or unparseable page is a problem, not a closing', () => {
  const d = decideTourDates({ id: 'x-tour-2024', openingDate: '2024-12-07' }, '<html>new layout</html>', '', NOW);
  assert.deepEqual(d.write, {});
  assert.match(d.problem, /zero engagements/);
});

test('an open range is not a closing; a closed one is', () => {
  assert.deepEqual(statedClosedRanges('<p>North American Tour 2022–</p>'), []);
  assert.deepEqual(statedClosedRanges('<p>First North American Tour (2024–2026)</p>'), [{ from: 2024, to: 2026 }]);
});

test('schedule slugs', () => {
  assert.deepEqual(scheduleSlugs({ title: "MJ" }), ['mj', 'mj-the-musical']);
  assert.deepEqual(scheduleSlugs({ title: 'Some Like It Hot', tourScheduleSlug: 'some-like-it-hot-tour' }), ['some-like-it-hot-tour']);
});
