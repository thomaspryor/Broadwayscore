import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDateRange, parseTourSchedule, segmentTourRows, decideTourDates, statedClosedRanges, scheduleSlugs, duplicateScheduleOf, wikiNamesOtherLaunch } = require('./tour-schedule.js');

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

test('footnote marks are stripped from city names (BRO-4601)', () => {
  const html = page([
    row('Chicago, IL ❖', 'CIBC Theatre', 'January 19-February 7, 2027'),
    row('Dallas, TX †', 'Music Hall', 'February 9-21, 2027'),
    row('Pueblo, CO *', 'Memorial Hall', 'February 24, 2027'),
    row('Montréal, QC §', 'Place des Arts', 'March 2-7, 2027'),
  ]);
  assert.deepEqual(parseTourSchedule(html).map(r => r.city), ['Chicago, IL', 'Dallas, TX', 'Pueblo, CO', 'Montréal, QC']);
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

// BRO-4601: Tours To You keeps only recent rows, so its first listed
// engagement is a launch only for a tour launching now, and only when the
// caller opts in (create-tour-entries; never the daily date job).
test('a fresh launch takes the first engagement only when opted in and near today', () => {
  const fresh = page([
    row('Providence, RI', 'PPAC', 'September 20-27, 2026'),
    row('Boston, MA', 'Citizens Bank Opera House', 'September 29-October 11, 2026'),
    row('Hartford, CT', 'The Bushnell', 'October 13-18, 2026'),
  ]);
  const tour = { id: null, title: 'X', openingDate: null, closingDate: null };
  const on = decideTourDates(tour, fresh, '', NOW, { segmentStart: '2026-09-20', freshLaunchDays: 60 });
  assert.deepEqual(on.write, { openingDate: '2026-09-20' });
  assert.equal(on.launchSource, 'tourstoyou-fresh');
  assert.deepEqual(decideTourDates(tour, fresh, '', NOW, { segmentStart: '2026-09-20' }).write, {}, 'off unless opted in');
  const old = page([
    row('Chicago, IL', 'Cadillac Palace', 'October 27-November 21, 2021'),
    row('Detroit, MI', 'Fisher Theatre', 'November 24-December 19, 2021'),
    row('Cleveland, OH', 'Connor Palace', 'January 5-30, 2022'),
  ]);
  const ancient = decideTourDates({ ...tour, id: 'x-tour-2021', openingDate: '2021-10-27' }, old, '', new Date('2022-01-10T00:00:00Z'), { freshLaunchDays: 60 });
  assert.notEqual(ancient.launchSource, 'tourstoyou-fresh', 'stored launch is kept');
  const stale = decideTourDates(tour, old, '', NOW, { segmentStart: '2021-10-27', freshLaunchDays: 60 });
  assert.deepEqual(stale.write, {}, 'a segment that started years ago is never taken as the launch');
  const elsewhere = 'The North American tour began at the Buell Theatre in Denver in May 2026. It later played Providence.';
  assert.deepEqual(decideTourDates(tour, fresh, elsewhere, NOW, { segmentStart: '2026-09-20', freshLaunchDays: 60 }).write, {}, 'Wikipedia names another launch city: the page lost the opener');
  const same = 'The North American tour began in Providence in September 2026.';
  assert.equal(decideTourDates(tour, fresh, same, NOW, { segmentStart: '2026-09-20', freshLaunchDays: 60 }).write.openingDate, '2026-09-20');
  const two = page([row('Providence, RI', 'PPAC', 'September 20-27, 2026'), row('Boston, MA', 'Opera House', 'September 29-October 11, 2026')]);
  assert.deepEqual(decideTourDates(tour, two, '', NOW, { segmentStart: '2026-09-20', freshLaunchDays: 60 }).write, {}, 'needs at least 3 engagements');
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

test('a BWW launch roundup dated near the first stop confirms the launch when Wikipedia is silent (BRO-4563)', () => {
  // Operation Mincemeat: Tours To You from 2026-09-20, BWW roundup 2026-09-30, Wikipedia silent.
  const html = page([
    row('Durham, NC', 'DPAC', 'September 20-27, 2026'),
    row('Washington, DC', 'National Theatre', 'September 29–October 11, 2026'),
    row('Boston, MA', 'Emerson Colonial', 'October 13-25, 2026'),
  ]);
  const blank = { id: null, title: 'Operation Mincemeat', openingDate: null, closingDate: null };
  // Found running on Tours To You (segmentStart), roundup carried on the row.
  const found = decideTourDates(blank, html, '', NOW, { segmentStart: '2026-09-20', roundupDate: '2026-09-30' });
  assert.deepEqual(found.write, { openingDate: '2026-09-20' });
  assert.equal(found.launchSource, 'bww-roundup');
  assert.ok(found.notes.some(n => /confirmed by the BroadwayWorld roundup dated 2026-09-30/.test(n)), found.notes.join(' | '));
  // A roundup row (seenAt = when the landing job saw it, days later).
  const seen = decideTourDates(blank, html, '', NOW, { seenAt: '2026-10-04T00:00:00Z', roundupDate: '2026-09-30' });
  assert.equal(seen.write.openingDate, '2026-09-20');
  assert.equal(seen.launchSource, 'bww-roundup');
  // No roundup date: unchanged, Wikipedia is still required.
  assert.deepEqual(decideTourDates(blank, html, '', NOW, { segmentStart: '2026-09-20' }).write, {});
  assert.equal(decideTourDates(blank, html, '', NOW, { segmentStart: '2026-09-20' }).launchSource, null);
  // A roundup far from the first stop is about something else.
  assert.deepEqual(decideTourDates(blank, html, '', NOW, { segmentStart: '2026-09-20', roundupDate: '2026-12-15' }).write, {});
  assert.deepEqual(decideTourDates(blank, html, '', NOW, { segmentStart: '2026-09-20', roundupDate: '2026-09-01' }).write, {});
  assert.match(decideTourDates(blank, html, '', NOW, { seenAt: '2026-10-04', roundupDate: '2026-12-15' }).problem, /no schedule segment/);
  // Wikipedia naming the launch still wins and is reported as such.
  const wiki = decideTourDates(blank, html, 'The North American tour began on September 20, 2026 in Durham', NOW, { segmentStart: '2026-09-20', roundupDate: '2026-09-30' });
  assert.equal(wiki.write.openingDate, '2026-09-20');
  assert.equal(wiki.launchSource, 'wikipedia');
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

test('an ended tour closes when Wikipedia says it ends in the last stop\'s month (BRO-4325, Suffs)', () => {
  const { wikiNamesClosingMonth } = require('./tour-schedule.js');
  const html = page([
    row('Yakima, WA', 'Capitol Theatre', 'September 8-14, 2025'),
    row('Seattle, WA', 'Paramount', 'September 16-28, 2025'),
    row('Denver, CO', 'Buell', 'January 6-18, 2026'),
    row('Houston, TX', 'Hobby Center', 'April 14-26, 2026'),
    row('Fort Worth, TX', 'Bass Hall', 'July 28-August 9, 2026'),
  ]);
  const wiki = 'The production closed in January 2025, and a North American tour began in September 2025 at the Capitol Theatre in Yakima and is scheduled to end in August 2026.';
  const d = decideTourDates({ id: 'suffs-tour-2025', title: 'Suffs', openingDate: null, closingDate: null }, html, wiki, NOW);
  assert.deepEqual(d.write, { openingDate: '2025-09-08', closingDate: '2026-08-09' });
  // A different month, a UK tour, or a tour still running never closes it.
  assert.equal(wikiNamesClosingMonth('The North American tour is scheduled to end in July 2026.', new Date('2026-08-09T00:00:00Z')), false);
  assert.equal(wikiNamesClosingMonth('The UK tour will end in August 2026.', new Date('2026-08-09T00:00:00Z')), false);
  const running = decideTourDates({ id: 'suffs-tour-2025', title: 'Suffs', openingDate: null, closingDate: null }, html, wiki, new Date('2026-08-01T00:00:00Z'));
  assert.equal(running.write.closingDate, undefined);
});

// BRO-4601: the Come From Away page carried Operation Mincemeat's 2026 table.
test('duplicateScheduleOf finds another tour sharing three engagements', () => {
  const mincemeat = { stops: [
    { city: 'Providence, RI', venue: 'PPAC', start: '2026-09-20' },
    { city: 'Chicago, IL', venue: 'CIBC Theatre', start: '2026-09-29' },
    { city: 'Boston, MA', venue: 'Emerson Colonial Theatre', start: '2026-10-13' },
  ] };
  const rows = parseTourSchedule(page([
    row('Providence, RI', 'PPAC', 'September 20-26, 2026'),
    row('Chicago, IL', 'CIBC Theatre', 'September 29–October 11, 2026'),
    row('Boston, MA', 'Emerson Colonial Theatre', 'October 13-25, 2026'),
  ]));
  assert.equal(duplicateScheduleOf(rows, { 'operation-mincemeat-tour-2026': mincemeat }), 'operation-mincemeat-tour-2026');
  assert.equal(duplicateScheduleOf(rows, { 'operation-mincemeat-tour-2026': mincemeat }, { exceptId: 'operation-mincemeat-tour-2026' }), null, 'a tour never duplicates itself');
  assert.equal(duplicateScheduleOf(rows.slice(0, 2), { m: mincemeat }), null, 'two shared stops can be chance');
  assert.equal(duplicateScheduleOf(mincemeat.stops, { m: { stops: mincemeat.stops.map(s => ({ ...s, city: 'Elsewhere' })) } }), null, 'same venue name in another city is not shared');
});

test('a tour booked ahead: its first listed engagement is the launch, only when asked', () => {
  const html = page([
    row('Cerritos, CA', 'Cerritos Center', 'January 19-24, 2027'),
    row('Phoenix, AZ', 'Orpheum', 'January 26-31, 2027'),
    row('Denver, CO', 'Buell', 'February 2-14, 2027'),
  ]);
  const tour = { id: null, title: 'Legally Blonde', openingDate: null, closingDate: null };
  const asked = decideTourDates(tour, html, '', NOW, { segmentStart: '2027-01-19', freshLaunchDays: 30, upcomingDays: 270 });
  assert.equal(asked.write.openingDate, '2027-01-19');
  assert.equal(asked.launchSource, 'tourstoyou-upcoming');
  assert.equal(decideTourDates(tour, html, '', NOW, { segmentStart: '2027-01-19', freshLaunchDays: 30 }).write.openingDate, undefined, 'not without upcomingDays');
  assert.equal(decideTourDates(tour, html, '', NOW, { segmentStart: '2027-01-19', upcomingDays: 30 }).write.openingDate, undefined, 'not beyond upcomingDays');
  // Wikipedia naming another launch city means the page lacks the opener.
  const other = decideTourDates(tour, html, 'The national tour will launch in Chicago in December 2026.', NOW, { segmentStart: '2027-01-19', upcomingDays: 270 });
  assert.equal(other.write.openingDate, undefined);
});

test('wikiNamesOtherLaunch: another city this season contradicts; old tours, a clipped sentence or a matching month with no place do not', () => {
  const R = (city, d) => ({ city, start: new Date(`${d}T00:00:00Z`) });
  // Harry Potter: the page starts at Seattle, the tour began in Denver.
  assert.equal(wikiNamesOtherLaunch('The North American tour began in Denver in May 2026.', R('Seattle, WA', '2026-08-22')), true);
  assert.equal(wikiNamesOtherLaunch('The North American tour began in Denver in May 2026.', R('Seattle, WA', '2026-05-20')), true, 'same month, other city');
  assert.equal(wikiNamesOtherLaunch('The North American tour began at the Buell Theatre in Denver.', R('Seattle, WA', '2026-08-22')), true, 'no year still counts');
  assert.equal(wikiNamesOtherLaunch('The national tour will launch in Chicago in January 2027.', R('Cerritos, CA', '2027-01-19')), true);
  // Legally Blonde's 2008 tour, an infobox field, a clipped window edge, Shucked's placeless month.
  assert.equal(wikiNamesOtherLaunch('The first national tour started in San Francisco on September 23, 2008.', R('Cerritos, CA', '2027-01-19')), false);
  assert.equal(wikiNamesOtherLaunch('| premiere_location = [[Golden Gate Theatre]], [[San Francisco]] tour launched', R('Cerritos, CA', '2027-01-19')), false);
  assert.equal(wikiNamesOtherLaunch('The first non-Equity tour launched in Jackson, Mississippi, on September', R('Cerritos, CA', '2027-01-19')), false);
  assert.equal(wikiNamesOtherLaunch('In August 2026, it was announced a non-equity 2nd National tour would begin in January, 2027.', R('Fort Wayne, IN', '2027-01-12')), false);
  assert.equal(wikiNamesOtherLaunch('The tour launched in Cerritos in January 2027.', R('Cerritos, CA', '2027-01-19')), false, 'names this city');
});
