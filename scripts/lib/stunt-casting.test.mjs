/**
 * BRO-5848: stunt-casting study logic, tested against the real functions
 * (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sc = require('./stunt-casting.js');

const show = (over = {}) => ({
  id: 'x-2010', slug: 'x', title: 'X', category: 'broadway', type: 'play',
  openingDate: '2010-10-01', cast: [{ name: 'A Star', role: 'Lead' }, { name: 'B Actor', role: 'Friend' }],
  ...over,
});

test('selectStudyShows: Broadway plays/musicals with a cast that have opened, from 2004-05', () => {
  const rows = sc.selectStudyShows([
    show(),
    show({ id: 'old', openingDate: '2004-06-30' }), // 2003-04 season
    show({ id: 'first', openingDate: '2004-07-01' }), // 2004-05 season, boundary day
    show({ id: 'we', category: 'west-end' }),
    show({ id: 'special', type: 'special' }),
    show({ id: 'nocast', cast: [] }),
    show({ id: 'future', openingDate: '2027-03-01' }),
    show({ id: 'closed', status: 'closed', closingDate: '2010-10-02' }),
  ], { today: '2026-10-21' });
  assert.deepEqual(rows.map(r => r.id), ['first', 'closed', 'x-2010']);
  assert.equal(rows[0].studySeason, '2004-2005');
});

test('validateClassification: headliners must come from the cast we sent', () => {
  const s = show();
  assert.equal(sc.validateClassification({ id: 'x-2010', headliners: [{ name: 'A Star', fame: 'screen' }] }, s).ok, true);
  assert.match(sc.validateClassification({ id: 'x-2010', headliners: [{ name: 'Invented Person', fame: 'screen' }] }, s).error, /not in cast/);
  assert.match(sc.validateClassification({ id: 'x-2010', headliners: [{ name: 'A Star', fame: 'famous' }] }, s).error, /bad fame/);
  assert.equal(sc.validateClassification({ id: 'other', headliners: [] }, s).ok, false);
  assert.equal(sc.validateClassification(undefined, s).ok, false);
});

test('classificationInputHash changes when the cast changes, not otherwise', () => {
  const a = sc.classificationInputHash(show());
  assert.equal(a, sc.classificationInputHash(show({ venue: 'Elsewhere' })));
  assert.notEqual(a, sc.classificationInputHash(show({ cast: [{ name: 'C New', role: 'Lead' }] })));
});

test('hasScreenStar vs hasCelebrity', () => {
  const music = [{ name: 'P', fame: 'music' }, { name: 'S', fame: 'stage' }];
  assert.equal(sc.hasScreenStar(music), false);
  assert.equal(sc.hasCelebrity(music), true);
  assert.equal(sc.hasScreenStar([{ name: 'F', fame: 'screen' }]), true);
  assert.equal(sc.hasCelebrity([{ name: 'S', fame: 'stage' }, { name: 'N', fame: 'none' }]), false);
});

test('bySeason / byEra percentages split plays and musicals', () => {
  const rows = [
    { season: '2010-2011', type: 'play', screenStar: true, celebrity: true },
    { season: '2010-2011', type: 'play', screenStar: false, celebrity: false },
    { season: '2010-2011', type: 'musical', screenStar: false, celebrity: true },
  ];
  const [s] = sc.bySeason(rows);
  assert.equal(s.screen.plays.pct, 50);
  assert.equal(s.screen.musicals.pct, 0);
  assert.equal(s.celebrity.musicals.pct, 100);
  assert.equal(Math.round(s.screen.all.pct), 33);
  const eras = sc.byEra(rows);
  assert.deepEqual(eras.map(e => e.label), ['2009–14']);
});

test('grossSummary: index against the weekly median, id or slug key, min weeks', () => {
  const weeks = {};
  for (let i = 0; i < 6; i++) {
    weeks[`2025-01-0${i + 1}`] = {
      a: { gross: 100 }, b: { gross: 200 }, c: { gross: 300 }, d: { gross: 400 }, e: { gross: 500 },
      'star-show': { gross: 600, capacity: 99, atp: 150 },
    };
  }
  const med = sc.weeklyMedians(weeks);
  assert.equal(med['2025-01-01'], 350);
  const g = sc.grossSummary(weeks, med, ['star-show-2025', 'star-show']);
  assert.equal(g.weeks, 6);
  assert.equal(g.avgCapacity, 99);
  assert.equal(g.grossIndex, 1.71);
  const short = { w1: weeks['2025-01-01'] };
  assert.equal(sc.grossSummary(short, sc.weeklyMedians(short), ['star-show']), null);
});

test('grossSummary: averages only the opening window; weeks counts the whole run', () => {
  const weeks = {};
  const total = sc.OPENING_WINDOW_WEEKS + 4;
  // Insert out of order: the window must follow week dates, not key order.
  for (let i = total - 1; i >= 0; i--) {
    const week = new Date(Date.UTC(2025, 0, 5 + i * 7)).toISOString().slice(0, 10);
    const late = i >= sc.OPENING_WINDOW_WEEKS;
    weeks[week] = {
      a: { gross: 100 }, b: { gross: 200 }, c: { gross: 300 }, d: { gross: 400 }, e: { gross: 500 },
      'long-run': { gross: late ? 30 : 600, atp: late ? 10 : 150 },
    };
  }
  const g = sc.grossSummary(weeks, sc.weeklyMedians(weeks), ['long-run']);
  assert.equal(g.weeks, total);
  assert.equal(g.avgAtp, 150);
  assert.equal(g.grossIndex, 1.71);
});

test('promptCast: opening-night cast beats the current cast; covers are dropped', () => {
  const s = show({
    cast: [{ name: 'Replacement Lead', role: 'Frank' }],
    openingCast: [
      { name: 'Luke Evans', role: 'Frank' },
      { name: 'Some Understudy', role: 'Frank', flags: ['Understudy'] },
      { name: 'A Swing', role: 'Swing' },
    ],
  });
  assert.deepEqual(sc.promptCast(s).map(c => c.name), ['Luke Evans']);
  const foxes = show({
    openingCast: [
      { name: 'Laura Linney', role: 'Regina Giddens', flags: ['Played Regina on opening night', 'Alternate'] },
      { name: 'Plain Alt', role: 'Regina Giddens', flags: ['Alternate'] },
    ],
  });
  assert.deepEqual(sc.promptCast(foxes).map(c => c.name), ['Laura Linney']);
  assert.deepEqual(sc.promptCast(show({ openingCast: [] })).map(c => c.name), ['A Star', 'B Actor']);
});

test('validateClassification: an ensemble show may have no headliners', () => {
  const r = sc.validateClassification({ id: 'x-2010', headliners: [] }, show());
  assert.equal(r.ok, true);
  assert.equal(sc.hasScreenStar(r.value.headliners), false);
});

test('isOneNightEvent: same-day benefit staging is out, an opening-night flop with previews stays', () => {
  assert.equal(sc.isOneNightEvent({ openingDate: '2004-09-20', closingDate: '2004-09-20' }), true);
  assert.equal(sc.isOneNightEvent({ openingDate: '2008-05-06', closingDate: '2008-05-06', previewsStartDate: '2008-04-22' }), false);
  assert.equal(sc.isOneNightEvent({ openingDate: '2010-10-26', closingDate: '2011-07-31' }), false);
  assert.equal(sc.isOneNightEvent({ openingDate: '2026-10-01' }), false);
});

test('commercialComparison: nonprofit productions stay out of both groups', () => {
  const row = (id, screenStar, designation) => ({
    id, type: 'play', season: '2016-2017', screenStar, designation,
    outcome: sc.commercialOutcome(designation), grosses: { grossIndex: 1, avgCapacity: 90, avgAtp: 100, weeks: 10 },
  });
  const c = sc.commercialComparison([row('a', true, 'Windfall'), row('b', true, 'Nonprofit'), row('c', false, 'Nonprofit'), row('d', false, 'Flop')]);
  assert.equal(c.play.star.n, 1);
  assert.equal(c.play.noStar.n, 1);
  assert.equal(c.play.star.recoupPct, 100);
  assert.equal(c.play.noStar.recoupPct, 0);
});

test('commercialOutcome: only settled designations count', () => {
  assert.equal(sc.commercialOutcome('Easy Winner'), 'recouped');
  assert.equal(sc.commercialOutcome('Trickle'), 'recouped');
  assert.equal(sc.commercialOutcome('Flop'), 'not-recouped');
  assert.equal(sc.commercialOutcome('Did Not Recoup'), 'not-recouped');
  assert.equal(sc.commercialOutcome('Nonprofit'), null);
  assert.equal(sc.commercialOutcome('TBD'), null);
  assert.equal(sc.commercialOutcome(null), null);
});
