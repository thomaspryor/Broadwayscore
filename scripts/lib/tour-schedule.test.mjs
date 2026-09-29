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
  assert.deepEqual(r('December 30&#x2013;January 4, 2026'), ['2025-12-30', '2026-01-04']);
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
  assert.deepEqual(decideTourDates(tour, html, 'The tour began on December 7, 2024 in Baltimore', NOW).write, { openingDate: '2024-12-07' });
  assert.deepEqual(
    decideTourDates(tour, html, 'The tour began on December 7, 2024 and closed on January 26, 2025', NOW).write,
    { openingDate: '2024-12-07', closingDate: '2025-01-26' },
  );
  const stated = html.replace('<p></p>', '<ul><li><span>North American Tour</span> (2024–2025)</li></ul>');
  assert.equal(decideTourDates({ ...tour, openingDate: '2024-12-07' }, stated, '', NOW).write.closingDate, '2025-01-26');
});

test('silence never closes: an empty or unparseable page is a problem, not a closing', () => {
  const d = decideTourDates({ id: 'x-tour-2024', openingDate: '2024-12-07' }, '<html>new layout</html>', '', NOW);
  assert.deepEqual(d.write, {});
  assert.match(d.problem, /zero engagements/);
});

test('an open range is not a closing; a closed North American one is; UK and body text never count', () => {
  assert.deepEqual(statedClosedRanges('<p>North American Tour 2022–</p>'), []);
  assert.deepEqual(statedClosedRanges('<ul><li><span>First North American Tour</span> (2024–2026)<ul><li>Union</li></ul></li></ul>'), [{ from: 2024, to: 2026 }]);
  assert.deepEqual(statedClosedRanges('=== North American tour (2024–2026) ==='), [{ from: 2024, to: 2026 }]);
  assert.deepEqual(statedClosedRanges('<p>UK tour (2024–2026)</p>'), []);
  assert.deepEqual(statedClosedRanges('The national tour ran 2024–2026 in body text.'), [], 'wiki body text is not a heading');
});

test('a mid-tour date named on Wikipedia is not taken as the launch', () => {
  const html = page([
    row('Providence, RI', 'PPAC', 'October 20-27, 2024'),
    row('Richmond, VA', 'Altria', 'October 29–November 3, 2024'),
    row('Atlanta, GA', 'Fox', 'December 10-15, 2024'),
    row('Denver, CO', 'Buell', 'March 4-9, 2025'),
  ]);
  const d = decideTourDates({ id: 'x-tour-2024', openingDate: null, closingDate: null }, html, 'played the Buell on March 4, 2025', NOW);
  assert.equal(d.write.openingDate, undefined);
});

test('schedule slugs', () => {
  assert.deepEqual(scheduleSlugs({ title: "MJ" }), ['mj', 'mj-the-musical']);
  assert.deepEqual(scheduleSlugs({ title: 'Some Like It Hot', tourScheduleSlug: 'some-like-it-hot-tour' }), ['some-like-it-hot-tour']);
});

test('a stated closed range in a Wikipedia heading closes a finished tour', () => {
  const html = page([
    row('Cleveland, OH', 'Playhouse Square', 'June 6-23, 2024'),
    row('Chicago, IL', 'Cadillac Palace', 'June 25–July 14, 2024'),
    row('Dallas, TX', 'Winspear', 'December 3-15, 2024'),
    row('Houston, TX', 'Hobby Center', 'June 3-15, 2025'),
    row('Miami, FL', 'Arsht', 'October 7-19, 2025'),
    row('Tampa, FL', 'Straz', 'January 6-18, 2026'),
    row('Denver, CO', 'Buell', 'July 8-19, 2026'),
  ]);
  const wiki = '=== North American tour (2024–2026) ===\nIt opened at Playhouse Square on June 6, 2024.';
  const d = decideTourDates({ id: 'x-tour-2024', openingDate: null, closingDate: null }, html, wiki, NOW);
  assert.deepEqual(d.write, { openingDate: '2024-06-06', closingDate: '2026-07-19' });
});

test('a summer layoff is not a closing; a New York run between tours is', () => {
  const html = page([
    row('Denver, CO', 'Buell', 'November 2-19, 2021'),
    row('Seattle, WA', 'Paramount', 'May 20–June 1, 2022'),
    row('Boston, MA', 'Citizens', 'October 3-16, 2022'),
  ]);
  const d = decideTourDates({ id: 'h-tour-2021', openingDate: '2021-11-02', closingDate: null }, html, '', NOW);
  assert.equal(d.write.closingDate, undefined, 'June to October gap stays one tour, and nothing confirms a close');
});

test('a new tour is matched only near when its roundup was seen', () => {
  const html = page([
    row('Fresno, CA', 'Saroyan', 'February 13, 2026'),
    row('Sacramento, CA', 'Memorial', 'February 17-22, 2026'),
  ]);
  const wiki = 'The second tour began on February 13, 2026 in Fresno';
  assert.equal(decideTourDates({ id: null }, html, wiki, NOW, { seenAt: '2026-02-20' }).write.openingDate, '2026-02-13');
  assert.match(decideTourDates({ id: null }, html, wiki, NOW, { seenAt: '2026-09-20' }).problem, /no schedule segment/);
  assert.match(decideTourDates({ id: null }, html, wiki, NOW).problem, /no schedule segment/, 'no seenAt, no guess');
});

test('a stray mention of the last stop date does not close a tour', () => {
  const html = page([
    row('Baltimore, MD', 'Hippodrome', 'December 7-14, 2024'),
    row('Washington, DC', 'Kennedy Center', 'December 17, 2024–January 5, 2025'),
    row('Fort Lauderdale, FL', 'Broward Center', 'January 21-26, 2025'),
  ]);
  const wiki = 'The tour began on December 7, 2024.\n\n' + 'x'.repeat(800) + ' The composer turned 50 on January 26, 2025.';
  assert.equal(decideTourDates({ id: 'x-tour-2024', openingDate: '2024-12-07', closingDate: null }, html, wiki, NOW).write.closingDate, undefined);
});
