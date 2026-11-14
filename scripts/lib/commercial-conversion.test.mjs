// BRO-5508: a nonprofit Broadway run that switched to a commercial run.
// The record shape, the validator's cross-field rules, the merge unit, and the
// model's refusal to charge nonprofit weeks to a commercial capitalization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { conversionOf, isConvertedToCommercial, commercialRunWeeks, recoupClockStart, conversionShapeProblems } = require('./commercial-conversion');
const { commercialRecordErrors } = require('./commercial-record-checks');
const { hasNoInvestorsToRepay } = require('./commercial-designations');
const { calculateRecoupment, calculateLifetimeRecoupment, SPLIT_RUN_ERROR } = require('./recoupment-model');
const { LINKED_FIELD_GROUPS } = require('./merge-commercial-data');

const SRC = 'https://www.reddit.com/r/Broadway/comments/1q5tsno/new_year_grosses_week_ending_january_4/';
const ragtime = {
  designation: 'TBD', nonprofitOrg: 'Lincoln Center Theater', productionType: 'enhancement',
  capitalization: null, recouped: null,
  commercialConversion: { date: '2026-01-05', sourceUrl: SRC },
};
const ragtimeRun = { slug: 'ragtime', previewsStartDate: '2025-09-26', openingDate: '2025-10-16', closingDate: '2026-08-16', status: 'closed' };
const conversionErrors = (rec, showRecord) =>
  commercialRecordErrors('x', rec, { showRecord }).filter((m) => /commercialConversion|commercial run/.test(m));

test('conversionOf reads the record, dropping a malformed date or URL instead of trusting it', () => {
  assert.deepEqual(conversionOf(ragtime), { date: '2026-01-05', sourceUrl: SRC });
  assert.deepEqual(conversionOf({ commercialConversion: { date: null, sourceUrl: SRC } }), { date: null, sourceUrl: SRC });
  assert.deepEqual(conversionOf({ commercialConversion: { date: '2026-02-30', sourceUrl: 'reddit' } }), { date: null, sourceUrl: null });
  for (const rec of [{}, null, undefined, { commercialConversion: null }, { commercialConversion: 'yes' }, { commercialConversion: [] }]) {
    assert.equal(conversionOf(rec), null);
    assert.equal(isConvertedToCommercial(rec), false);
  }
  assert.equal(isConvertedToCommercial(ragtime), true);
});

test('commercialRunWeeks keeps only the weeks played on commercial terms', () => {
  // Ragtime's grosses weeks around the switch (week-ending Sundays): Jan 4 was the last LORT week.
  const weeks = ['2025-12-28', '2026-01-04', '2026-01-11', '2026-01-18'].map((week) => ({ week, gross: 1 }));
  assert.deepEqual(commercialRunWeeks(ragtime, weeks).map((r) => r.week), ['2026-01-11', '2026-01-18']);
  // A switch recorded on a Sunday leaves that week, played on nonprofit terms, out.
  const sunday = { ...ragtime, commercialConversion: { date: '2026-01-04', sourceUrl: SRC } };
  assert.deepEqual(commercialRunWeeks(sunday, weeks).map((r) => r.week), ['2026-01-11', '2026-01-18']);
  // An undated switch cannot be split: no week counts as commercial.
  assert.deepEqual(commercialRunWeeks({ ...ragtime, commercialConversion: { date: null, sourceUrl: SRC } }, weeks), []);
  // A record that never switched: null, so callers keep their own rule.
  assert.equal(commercialRunWeeks({ designation: 'TBD' }, weeks), null);
});

test('conversionShapeProblems names each bad part', () => {
  assert.deepEqual(conversionShapeProblems(undefined), []);
  assert.deepEqual(conversionShapeProblems({ date: '2026-01-05', sourceUrl: SRC }), []);
  assert.deepEqual(conversionShapeProblems({ date: null, sourceUrl: SRC }), []);
  assert.deepEqual(conversionShapeProblems(null), ['must be an object { date, sourceUrl }']);
  const bad = conversionShapeProblems({ date: '2026-1-5', sourceUrl: '', venue: 'Belasco' });
  assert.equal(bad.length, 3);
  assert.match(bad[0], /date must be YYYY-MM-DD or null/);
  assert.match(bad[1], /sourceUrl/);
  assert.match(bad[2], /unknown keys: venue/);
});

test('validator: a converted record is a commercial production with a nonprofit origin and a date inside its run', () => {
  assert.deepEqual(conversionErrors(ragtime, ragtimeRun), []);
  assert.deepEqual(conversionErrors({ ...ragtime, commercialConversion: { date: null, sourceUrl: SRC } }, ragtimeRun), []);
  assert.match(conversionErrors({ ...ragtime, designation: 'Nonprofit' }, ragtimeRun)[0], /designation "Nonprofit"/);
  assert.match(conversionErrors({ ...ragtime, designation: 'Tour Stop' }, ragtimeRun)[0], /designation "Tour Stop"/);
  assert.match(conversionErrors({ ...ragtime, nonprofitOrg: undefined }, ragtimeRun)[0], /no nonprofitOrg/);
  assert.match(conversionErrors({ ...ragtime, commercialConversion: { date: '2025-09-26', sourceUrl: SRC } }, ragtimeRun)[0], /not after the first preview/);
  assert.match(conversionErrors({ ...ragtime, commercialConversion: { date: '2026-09-01', sourceUrl: SRC } }, ragtimeRun)[0], /after the closing date/);
  // Appropriate recouped the month its Belasco run began: same month is fine, an earlier one is not.
  assert.deepEqual(conversionErrors({ ...ragtime, recouped: true, recoupedDate: '2026-01' }, ragtimeRun), []);
  assert.match(conversionErrors({ ...ragtime, recouped: true, recoupedDate: '2025-12-20' }, ragtimeRun)[0], /before its commercial run began/);
  // Without the shows.json record the date checks wait; the shape and label checks still run.
  assert.deepEqual(conversionErrors(ragtime, undefined), []);
  assert.equal(conversionErrors({ ...ragtime, commercialConversion: { date: 'soon', sourceUrl: SRC } }, ragtimeRun).length, 1);
});

test('a converted run has investors to repay, through its designation (one switch, not two)', () => {
  assert.equal(hasNoInvestorsToRepay(ragtime), false);
  assert.equal(hasNoInvestorsToRepay({ designation: 'Nonprofit', nonprofitOrg: 'Manhattan Theatre Club' }), true);
});

test('the merge keeps the conversion with the designation it requires', () => {
  const unit = LINKED_FIELD_GROUPS.find((g) => g.includes('designation'));
  assert.ok(unit.includes('commercialConversion'));
});

test('the model does not charge nonprofit weeks to a commercial capitalization: a split run is not modelled', () => {
  const show = { ...ragtimeRun, type: 'play', venue: 'Helen Hayes Theater', closingDate: '2024-06-30', previewsStartDate: '2023-11-29', openingDate: '2023-12-18' };
  const weekly = {};
  for (let i = 0; i < 30; i++) weekly[new Date(Date.UTC(2023, 11, 3 + 7 * i)).toISOString().slice(0, 10)] = { gross: 600000, performances: 8, attendance: 4000 };
  const allTime = { gross: 18000000, performances: 240, attendance: 120000 };
  // No weekly cost on the record: the model estimates one (and tests/unit/cost-for-week.test.mjs keeps new files off that field).
  const comm = { designation: 'Easy Winner', recouped: true, recoupedDate: '2024-03', capitalization: 3750000, nonprofitOrg: 'Second Stage Theater' };
  const plain = calculateRecoupment(show, comm, allTime, weekly);
  assert.equal(plain.error, undefined, 'an ordinary record still models');
  const converted = { ...comm, commercialConversion: { date: '2024-03-25', sourceUrl: 'https://playbill.com/article/broadways-appropriate-extension-begins-march-25' } };
  assert.deepEqual(calculateRecoupment(show, converted, allTime, weekly), { error: SPLIT_RUN_ERROR, warnings: [SPLIT_RUN_ERROR] });
  assert.equal(calculateLifetimeRecoupment(show, converted, allTime).error, SPLIT_RUN_ERROR);
});

test('recoupClockStart: opening night, the commercial start for a run that switched, null when the switch is undated', () => {
  assert.equal(recoupClockStart({}, '2023-12-18'), '2023-12-18');
  assert.equal(recoupClockStart(null, null), null);
  assert.equal(recoupClockStart({ commercialConversion: { date: '2024-03-25', sourceUrl: 'https://x.test/a' } }, '2023-12-18'), '2024-03-25');
  assert.equal(recoupClockStart({ commercialConversion: { date: null, sourceUrl: 'https://x.test/a' } }, '2026-04-23'), null);
});
