// Parser test for scripts/lib/playbill-broadway-schedule.js using a captured
// snapshot of Playbill's "Schedule of Upcoming and Announced Broadway Shows"
// article. Per feedback_test_extraction_pattern.md: require the real lib,
// don't reimplement the parser in the test.
//
// Card #1426: TodayTix never carries a real Broadway openingDate (only
// previews), and IBDB enrichment can match the wrong (much older) production
// for a common title. Playbill's schedule article publishes both dates
// explicitly per-show, and is the source that already caught 5 announced
// shows shows.json was missing entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlaybillBroadwaySchedule, parseUSDate, titleCaseFromAllCaps } = require('../../scripts/lib/playbill-broadway-schedule.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, '..', 'fixtures', 'broadway-discovery', 'playbill-broadway.html'), 'utf8');
// Sprint-plan S0-T2c: the 2026-09-28 capture, whose titles with digits,
// `;` and quotes ("860", "SCHOOL GIRLS; OR, …", 'BLUE MAN GROUP "…"', "10
// THINGS …") the old title class rejected — and, because a segment ran to
// the next MATCHED anchor, each rejected show's venue/dates overwrote the
// previous entry's.
const FIXTURE_2026_09_28 = readFileSync(join(__dirname, '..', 'fixtures', 'broadway-discovery', 'playbill-broadway-2026-09-28.html'), 'utf8');

// Text-derived truth for the 2026-09-28 article (agentA's audit): every
// listing before the "IN THE WORKS" tail, in document order. Titles are the
// article's ALL CAPS; venues normalised (&nbsp; -> space); dates ISO.
const EXPECTED_2026_09_28 = [
  ['SCHOOL GIRLS; OR, THE AFRICAN MEAN GIRLS PLAY', 'Samuel J. Friedman Theatre', '2026-09-08', null, '2026-09-28'],
  ['THE IMAGINARY INVALID', 'Todd Haimes Theatre', '2026-09-25', null, '2026-10-22'],
  ['OTHER DESERT CITIES', 'Hudson Theatre', '2026-09-29', null, '2026-10-18'],
  ['860', 'Imperial Theatre', '2026-10-01', null, '2026-10-21'],
  ['A FEW GOOD MEN', 'Vivian Beaumont Theatre', '2026-10-08', null, '2026-10-29'],
  ['WANTED', 'James Earl Jones Theatre', '2026-10-15', null, '2026-11-08'],
  ['DOWNSTATE', 'Booth Theatre', '2026-10-17', null, '2026-11-15'],
  ['THE FANTASTICKS', 'Hayes Theatre', '2026-10-22', null, '2026-11-16'],
  ['MUCH ADO ABOUT NOTHING', 'Winter Garden Theatre', '2026-10-31', null, '2026-11-19'],
  ['HERE THERE ARE BLUEBERRIES', 'Ethel Barrymore Theatre', '2026-11-02', null, '2026-11-09'],
  ['GALILEO', 'Shubert Theatre', '2026-11-10', null, '2026-12-06'],
  ['INTER ALIA', 'Music Box Theatre', '2026-11-10', null, '2026-12-01'],
  ['NOW YOU SEE ME LIVE', 'Al Hirschfeld Theatre', null, null, '2026-11-11'],
  ['BLUE MAN GROUP "A NEW HOLIDAY SURPRISE"', 'Lunt-Fontanne Theatre', '2026-11-12', null, '2026-11-17'],
  ['DOLLY: A TRUE ORIGINAL MUSICAL', 'St. James Theatre', '2026-12-07', null, '2027-01-19'],
  ['AWAKE AND SING!', 'Samuel J. Friedman Theatre', '2026-12-15', null, '2027-01-07'],
  ['MIX AND MASTER', 'Todd Haimes Theatre', '2027-01-05', null, '2027-01-27'],
  ['SMALL MOUTH SOUNDS', 'Ethel Barrymore Theatre', '2027-02-18', null, '2027-03-18'],
  ['EVITA', 'Winter Garden Theatre', '2027-02-27', null, '2027-03-25'],
  ['PURPLE RAIN', 'Majestic Theatre', '2027-03-12', null, '2027-04-12'],
  ['GLORIA', 'Hayes Theatre', '2027-03-17', null, '2027-04-05'],
  ['THE SOUND OF MUSIC', 'Vivian Beaumont Theatre', '2027-03-23', null, '2027-04-15'],
  ['DAMN YANKEES', 'Marquis Theatre', '2027-03-24', null, '2027-04-20'],
  ['PADDINGTON THE MUSICAL', 'Al Hirschfeld Theatre', '2027-03-30', null, '2027-04-18'],
  ['THE FULL MONTY', 'Todd Haimes Theatre', '2027-04-03', null, '2027-04-25'],
  ['WARRIORS', 'Lunt-Fontanne Theatre', null, 'March 2027', null],
  ['MONTAUK', 'Samuel J. Friedman Theatre', null, 'Spring 2027', null],
  ['CAT ON A HOT TIN ROOF', null, null, 'Spring 2027', null],
  ['THREE DAYS OF RAIN', null, null, 'February 2027', null],
  ['LET THE GOOD TIMES ROLL', null, null, null, null],
  ['PRIVATE LIVES', null, null, null, null],
  ['10 THINGS I HATE ABOUT YOU', null, '2027-08-17', null, null],
  ['ANNIE', null, null, 'Fall 2027', null],
];

test('parsePlaybillBroadwaySchedule returns entries with title + venue/date signal', () => {
  const entries = parsePlaybillBroadwaySchedule(FIXTURE);
  assert.ok(entries.length >= 15, `expected >=15 entries, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.title && e.title.length >= 2, `entry has title: ${JSON.stringify(e)}`);
    assert.equal(e.source, 'playbill-broadway');
    if (e.firstPreview) assert.match(e.firstPreview, /^\d{4}-\d{2}-\d{2}$/);
    if (e.opening) assert.match(e.opening, /^\d{4}-\d{2}-\d{2}$/);
  }
  // Since S0-T2c the "ANNOUNCED … WITHOUT CONFIRMED DATE OR VENUE" tier is
  // kept even when Playbill has published nothing yet (Private Lives, Let
  // the Good Times Roll), so not EVERY entry carries a signal — but the
  // dated tier must, and it must be the bulk of the article.
  const withSignal = entries.filter(e => e.venue || e.firstPreview || e.firstPreviewApprox);
  assert.ok(withSignal.length >= 15, `expected >=15 entries with a venue or date signal, got ${withSignal.length}`);
  const bare = entries.filter(e => !e.venue && !e.firstPreview && !e.firstPreviewApprox && !e.opening);
  assert.ok(bare.length <= 3, `only the announced-but-unconfirmed handful may lack every signal, got ${bare.length}: ${bare.map(e => e.title).join(' / ')}`);
});

test('parsePlaybillBroadwaySchedule rejects HTML whose page title does not match', () => {
  const wrongTitleHTML = '<html><head><title>Some Other Page</title></head><body><a href="x" target="_blank">SOME SHOW</a><br>Theatre: X Theatre<br>First Preview: April 1, 2026</body></html>';
  const entries = parsePlaybillBroadwaySchedule(wrongTitleHTML);
  assert.deepEqual(entries, []);
});

test('parsePlaybillBroadwaySchedule returns empty on empty/null HTML', () => {
  assert.deepEqual(parsePlaybillBroadwaySchedule(''), []);
  assert.deepEqual(parsePlaybillBroadwaySchedule(null), []);
});

test('parsePlaybillBroadwaySchedule drops the "IN THE WORKS" speculative tail (no venue, no date)', () => {
  const entries = parsePlaybillBroadwaySchedule(FIXTURE);
  const speculative = ['ALI', 'GATSBY', 'THE GREATEST SHOWMAN', 'LA LA LAND', 'DAMN YANKEES'];
  const titles = entries.map(e => e.title);
  for (const t of speculative) {
    assert.ok(!titles.includes(t), `"${t}" is speculative (Creative Team only, no venue/date) and should be dropped`);
  }
});

test('parsePlaybillBroadwaySchedule fixture contains the 5 announced shows missing from shows.json (card #1426)', () => {
  const entries = parsePlaybillBroadwaySchedule(FIXTURE);
  const byTitle = new Map(entries.map(e => [e.title, e]));

  const wanted = byTitle.get('WANTED');
  assert.ok(wanted, 'WANTED present');
  assert.equal(wanted.venue, 'James Earl Jones Theatre');
  assert.equal(wanted.firstPreview, '2026-10-15');
  assert.equal(wanted.opening, '2026-11-08');

  const muchAdo = byTitle.get('MUCH ADO ABOUT NOTHING');
  assert.ok(muchAdo, 'MUCH ADO ABOUT NOTHING present');
  assert.equal(muchAdo.venue, 'Winter Garden Theatre');
  assert.equal(muchAdo.firstPreview, '2026-10-31');
  assert.equal(muchAdo.opening, '2026-11-19');

  const mixAndMaster = byTitle.get('MIX AND MASTER');
  assert.ok(mixAndMaster, 'MIX AND MASTER present');
  assert.equal(mixAndMaster.venue, 'Todd Haimes Theatre');
  assert.equal(mixAndMaster.firstPreview, '2027-01-05');
  assert.equal(mixAndMaster.opening, '2027-01-27');

  const fullMonty = byTitle.get('THE FULL MONTY');
  assert.ok(fullMonty, 'THE FULL MONTY present');
  assert.equal(fullMonty.venue, 'Todd Haimes Theatre');
  assert.equal(fullMonty.firstPreview, '2027-04-03');
  assert.equal(fullMonty.opening, '2027-04-25');

  const threeDaysOfRain = byTitle.get('THREE DAYS OF RAIN');
  assert.ok(threeDaysOfRain, 'THREE DAYS OF RAIN present');
  assert.equal(threeDaysOfRain.venue, null, 'venue not yet confirmed per Playbill');
  assert.equal(threeDaysOfRain.firstPreview, null, 'no day-level date published yet');
  assert.equal(threeDaysOfRain.firstPreviewApprox, 'February 2027');
  assert.equal(threeDaysOfRain.opening, null, 'opening not yet confirmed per Playbill');
});

test('parsePlaybillBroadwaySchedule also carries openingDate for shows whose IBDB page matches the wrong (older) production', () => {
  // Card #1426 gap 1: galileo-2026/inter-alia-2026/paranormal-activity-2026 had
  // openingDate collected via IBDB successfully; awake-and-sing-2026 and
  // the-imaginary-invalid-2026 did not, because their stored ibdbUrl points at
  // a decades-old prior Broadway production of the same title and the
  // wrong-production guard (correctly) refuses to trust it. Playbill's own
  // schedule article is immune to that failure mode — it only ever lists the
  // current production.
  const entries = parsePlaybillBroadwaySchedule(FIXTURE);
  const byTitle = new Map(entries.map(e => [e.title, e]));

  const awakeAndSing = byTitle.get('AWAKE AND SING!');
  assert.ok(awakeAndSing, 'AWAKE AND SING! present');
  assert.equal(awakeAndSing.opening, '2027-01-07');

  const imaginaryInvalid = byTitle.get('THE IMAGINARY INVALID');
  assert.ok(imaginaryInvalid, 'THE IMAGINARY INVALID present');
  assert.equal(imaginaryInvalid.opening, '2026-10-22');
});

// ---- S0-T2c: 2026-09-28 fixture ------------------------------------------

test('2026-09-28 fixture: parser returns all 33 listings, in order, with the article\'s own venue/dates (no bleed)', () => {
  const entries = parsePlaybillBroadwaySchedule(FIXTURE_2026_09_28);
  assert.equal(entries.length, 33, `expected 33 entries, got ${entries.length}: ${entries.map(e => e.title).join(' / ')}`);
  const rows = entries.map(e => [e.title, e.venue, e.firstPreview, e.firstPreviewApprox, e.opening]);
  assert.deepEqual(rows, EXPECTED_2026_09_28);
  for (const e of entries) {
    assert.equal(e.source, 'playbill-broadway');
    assert.match(e.url, /^https?:\/\/playbill\.com\//, `entry url is the show's own article: ${e.title}`);
  }
});

test('2026-09-28 fixture: titles with digits, ";", quotes and a <strong>-split first letter are kept', () => {
  const titles = parsePlaybillBroadwaySchedule(FIXTURE_2026_09_28).map(e => e.title);
  assert.ok(titles.includes('860'), '860 (all digits)');
  assert.ok(titles.includes('BLUE MAN GROUP "A NEW HOLIDAY SURPRISE"'), 'Blue Man Group (straight quotes)');
  // Rendered as <strong>S</strong>CHOOL GIRLS; OR, … in the article.
  assert.ok(titles.includes('SCHOOL GIRLS; OR, THE AFRICAN MEAN GIRLS PLAY'), 'School Girls (semicolon + split first letter)');
  assert.ok(titles.includes('10 THINGS I HATE ABOUT YOU'), '10 Things (leading digits)');
  assert.equal(new Set(titles).size, titles.length, 'no duplicate titles');
});

test('2026-09-28 fixture: a rejected neighbour no longer overwrites the previous entry (Other Desert Cities / Now You See Me / Private Lives)', () => {
  const byTitle = new Map(parsePlaybillBroadwaySchedule(FIXTURE_2026_09_28).map(e => [e.title, e]));

  // Was parsed as 860's Imperial Theatre / 2026-10-01 / 2026-10-21.
  const odc = byTitle.get('OTHER DESERT CITIES');
  assert.ok(odc, 'OTHER DESERT CITIES present');
  assert.equal(odc.venue, 'Hudson Theatre');
  assert.equal(odc.firstPreview, '2026-09-29');
  assert.equal(odc.opening, '2026-10-18');
  assert.match(odc.url, /other-desert-cities/);

  // Was parsed as Blue Man Group's Lunt-Fontanne / 2026-11-12 / 2026-11-17.
  const nysm = byTitle.get('NOW YOU SEE ME LIVE');
  assert.ok(nysm, 'NOW YOU SEE ME LIVE present');
  assert.equal(nysm.venue, 'Al Hirschfeld Theatre');
  assert.equal(nysm.firstPreview, null, 'the article lists no first preview for it');
  assert.equal(nysm.firstPreviewApprox, null);
  assert.equal(nysm.opening, '2026-11-11');

  const blueMan = byTitle.get('BLUE MAN GROUP "A NEW HOLIDAY SURPRISE"');
  assert.equal(blueMan.venue, 'Lunt-Fontanne Theatre');
  assert.equal(blueMan.firstPreview, '2026-11-12');
  assert.equal(blueMan.opening, '2026-11-17');

  // Was parsed with 10 Things' 2027-08-17 first preview.
  const privateLives = byTitle.get('PRIVATE LIVES');
  assert.ok(privateLives, 'PRIVATE LIVES present (announced, no venue or date yet)');
  assert.equal(privateLives.venue, null);
  assert.equal(privateLives.firstPreview, null);
  assert.equal(privateLives.firstPreviewApprox, null);
  assert.equal(privateLives.opening, null);

  const tenThings = byTitle.get('10 THINGS I HATE ABOUT YOU');
  assert.equal(tenThings.venue, null);
  assert.equal(tenThings.firstPreview, '2027-08-17');
  assert.equal(tenThings.opening, null);
});

test('2026-09-28 fixture: the "IN THE WORKS" tail is dropped by its header, dated-or-not', () => {
  const titles = parsePlaybillBroadwaySchedule(FIXTURE_2026_09_28).map(e => e.title);
  for (const t of ['13 GOING ON 30', 'ALI', 'FAHRENHEIT 451', 'GATSBY', 'THE GREATEST SHOWMAN', 'LA LA LAND', 'BROADWAY VACATION', "THE GRISWOLDS' BROADWAY VACATION"]) {
    assert.ok(!titles.includes(t), `"${t}" is in the speculative tail and must be dropped`);
  }
  // DAMN YANKEES moved from the tail into the dated tier in this capture.
  assert.ok(titles.includes('DAMN YANKEES'));
});

test('original fixture: the same parser still yields the card #1426 entries and now also the digit/semicolon titles it used to drop', () => {
  const entries = parsePlaybillBroadwaySchedule(FIXTURE);
  const byTitle = new Map(entries.map(e => [e.title, e]));
  assert.ok(byTitle.has('860'), '860 present in the original capture too');
  assert.ok(byTitle.has('SCHOOL GIRLS; OR, THE AFRICAN MEAN GIRLS PLAY'));
  // The original capture had the same bleed: Paranormal Activity carried
  // School Girls' Friedman/09-08/09-28, Other Desert Cities carried 860's.
  const pa = byTitle.get('PARANORMAL ACTIVITY');
  assert.equal(pa.venue, 'August Wilson Theatre');
  assert.equal(pa.firstPreview, '2026-08-14');
  assert.equal(pa.opening, '2026-08-25');
  const odc = byTitle.get('OTHER DESERT CITIES');
  assert.equal(odc.venue, 'Hudson Theatre');
  assert.equal(odc.firstPreview, '2026-09-29');
  assert.equal(odc.opening, '2026-10-18');
});

test('segments terminate at the next schedule anchor even when that anchor\'s text fails the title class', () => {
  // A title shape the class does not anticipate (lowercase) must drop only
  // itself — its Theatre/First Preview lines must not leak into GOOD SHOW.
  const html = `<html><head><title>Schedule of Upcoming and Announced Broadway Shows | Playbill</title></head><body>
<p><strong><u>2026-2027 SEASON</u></strong></p>
<p><a href="https://playbill.com/article/good-show" target="_blank"><strong>GOOD SHOW</strong></a><br>Theatre: Booth Theatre<br>First Preview: October 1, 2026<br>Opening: October 20, 2026<br>About: Fine.</p>
<p><a href="https://playbill.com/article/odd-show" target="_blank"><strong>An oddly cased title</strong></a><br>Theatre: Imperial Theatre<br>First Preview: November 1, 2026<br>Opening: November 20, 2026<br>About: Rejected.</p>
<p><a href="https://playbill.com/article/next-show" target="_blank"><strong>NEXT SHOW</strong></a><br>Theatre: Hudson Theatre<br>First Preview: December 1, 2026<br>About: Also fine. Read <a href="https://playbill.com/article/inline" target="_blank">this inline link</a> too.</p>
<p><strong><u>IN&nbsp;THE WORKS</u></strong></p>
<p><a href="https://playbill.com/article/spec" target="_blank"><strong>SPECULATIVE</strong></a><br>Theatre: Marquis Theatre<br>About: Tail.</p>
</body></html>`;
  const entries = parsePlaybillBroadwaySchedule(html);
  assert.deepEqual(entries.map(e => [e.title, e.venue, e.firstPreview, e.opening]), [
    ['GOOD SHOW', 'Booth Theatre', '2026-10-01', '2026-10-20'],
    ['NEXT SHOW', 'Hudson Theatre', '2026-12-01', null],
  ]);
});

test('a title split across two same-href anchors is merged; a <strong>-split first letter is joined without a space', () => {
  const html = `<html><head><title>Schedule of Upcoming and Announced Broadway Shows | Playbill</title></head><body>
<p><strong><a href="https://playbill.com/article/griswolds" target="_blank">THE GRISWOLDS' </a></strong><strong><a href="https://playbill.com/article/griswolds" target="_blank">BROADWAY VACATION</a></strong><br>Theatre: Nederlander Theatre<br>First Preview: March 2, 2027</p>
<p><strong><a href="https://playbill.com/article/school-girls" target="_blank"></a></strong><strong><strong><a href="https://playbill.com/article/school-girls" target="_blank"><strong>S</strong>CHOOL GIRLS; OR, THE AFRICAN MEAN GIRLS PLAY</a></strong></strong><br>Theatre: Samuel J. Friedman Theatre<br>First Preview: September 8, 2026</p>
</body></html>`;
  const entries = parsePlaybillBroadwaySchedule(html);
  assert.deepEqual(entries.map(e => [e.title, e.venue, e.firstPreview]), [
    ["THE GRISWOLDS' BROADWAY VACATION", 'Nederlander Theatre', '2027-03-02'],
    ['SCHOOL GIRLS; OR, THE AFRICAN MEAN GIRLS PLAY', 'Samuel J. Friedman Theatre', '2026-09-08'],
  ]);
});

test('without an "IN THE WORKS" header the parser falls back to dropping venue-less, date-less entries', () => {
  const html = `<html><head><title>Schedule of Upcoming and Announced Broadway Shows | Playbill</title></head><body>
<p><a href="https://playbill.com/article/dated" target="_blank"><strong>DATED SHOW</strong></a><br>Theatre: Booth Theatre<br>First Preview: October 1, 2026</p>
<p><a href="https://playbill.com/article/bare" target="_blank"><strong>BARE TITLE</strong></a><br>Writer: Someone<br>About: Nothing confirmed.</p>
</body></html>`;
  const entries = parsePlaybillBroadwaySchedule(html);
  assert.deepEqual(entries.map(e => e.title), ['DATED SHOW']);
});

test('parseUSDate parses full US dates and rejects month-only text', () => {
  assert.equal(parseUSDate('November 8, 2026'), '2026-11-08');
  assert.equal(parseUSDate('Jan. 7, 2027'), '2027-01-07');
  assert.equal(parseUSDate('February 2027'), null);
  assert.equal(parseUSDate(''), null);
  assert.equal(parseUSDate(null), null);
});

test('titleCaseFromAllCaps converts ALL CAPS titles to sentence-style title case', () => {
  assert.equal(titleCaseFromAllCaps('WANTED'), 'Wanted');
  assert.equal(titleCaseFromAllCaps('MUCH ADO ABOUT NOTHING'), 'Much Ado About Nothing');
  assert.equal(titleCaseFromAllCaps('MIX AND MASTER'), 'Mix and Master');
  assert.equal(titleCaseFromAllCaps('THE FULL MONTY'), 'The Full Monty');
  assert.equal(titleCaseFromAllCaps("AWAKE AND SING!"), 'Awake and Sing!');
});

test('titleCaseFromAllCaps does NOT treat an apostrophe as a word boundary (regression: ship-check finding)', () => {
  // "COAL MINER'S DAUGHTER" must not become "Coal Miner'S Daughter" —
  // the apostrophe-owner's initial is not a new word.
  assert.equal(titleCaseFromAllCaps("COAL MINER'S DAUGHTER"), "Coal Miner's Daughter");
  assert.equal(titleCaseFromAllCaps("AIN'T TOO PROUD"), "Ain't Too Proud");
  assert.equal(titleCaseFromAllCaps("THE GRISWOLDS'"), "The Griswolds'");
});

test('titleCaseFromAllCaps leaves already-mixed-case titles untouched', () => {
  assert.equal(titleCaseFromAllCaps('Hamilton'), 'Hamilton');
  assert.equal(titleCaseFromAllCaps('MJ the Musical'), 'MJ the Musical');
});

test('titleCaseFromAllCaps handles null/empty', () => {
  assert.equal(titleCaseFromAllCaps(''), '');
  assert.equal(titleCaseFromAllCaps(null), null);
});
