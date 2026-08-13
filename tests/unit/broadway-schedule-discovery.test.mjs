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
const { parsePlaybillBroadwaySchedule, parseUSDate } = require('../../scripts/lib/playbill-broadway-schedule.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, '..', 'fixtures', 'broadway-discovery', 'playbill-broadway.html'), 'utf8');

test('parsePlaybillBroadwaySchedule returns entries with title + venue/date signal', () => {
  const entries = parsePlaybillBroadwaySchedule(FIXTURE);
  assert.ok(entries.length >= 15, `expected >=15 entries, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.title && e.title.length >= 2, `entry has title: ${JSON.stringify(e)}`);
    assert.equal(e.source, 'playbill-broadway');
    assert.ok(e.venue || e.firstPreview || e.firstPreviewApprox, `entry has a venue or date signal: ${JSON.stringify(e)}`);
    if (e.firstPreview) assert.match(e.firstPreview, /^\d{4}-\d{2}-\d{2}$/);
    if (e.opening) assert.match(e.opening, /^\d{4}-\d{2}-\d{2}$/);
  }
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

test('parseUSDate parses full US dates and rejects month-only text', () => {
  assert.equal(parseUSDate('November 8, 2026'), '2026-11-08');
  assert.equal(parseUSDate('Jan. 7, 2027'), '2027-01-07');
  assert.equal(parseUSDate('February 2027'), null);
  assert.equal(parseUSDate(''), null);
  assert.equal(parseUSDate(null), null);
});
