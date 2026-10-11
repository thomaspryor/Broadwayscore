// Unit tests for scripts/lib/grosses-run-window.js and rekeyRowsToRuns in
// scripts/lib/grosses-history-repair.js (BRO-5016). Run dates are the
// shows.json entries of the productions named, checked 2026-10-10.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../../scripts/lib/grosses-run-window.js');
const { rekeyRowsToRuns, repairGrossesHistory } = require('../../scripts/lib/grosses-history-repair.js');

const NOW = Date.parse('2026-10-10');
const t = (title) => ({ title });

const cabaret2014 = { id: 'cabaret-2014', slug: 'cabaret-2014', title: 'Cabaret', category: 'broadway', originalProductionId: 'cabaret-1987', previewsStartDate: '2014-03-21', openingDate: '2014-04-24', closingDate: '2015-03-29' };
const cabaret2024 = { id: 'cabaret-2024', slug: 'cabaret-2024', title: 'Cabaret at the Kit Kat Club', category: 'broadway', originalProductionId: 'cabaret-1987', previewsStartDate: '2024-04-01', openingDate: '2024-04-21', closingDate: '2025-09-21' };
const cabaretWE = { id: 'cabaret-at-the-kit-kat-club-west-end-2021', slug: 'cabaret-at-the-kit-kat-club-west-end-2021', title: 'Cabaret at the Kit Kat Club', category: 'west-end', openingDate: '2021-12-16' };
const romeo2013 = { id: 'romeo-and-juliet-2013', slug: 'romeo-and-juliet-2013', title: 'Romeo and Juliet', category: 'broadway', previewsStartDate: '2013-08-24', openingDate: '2013-09-19', closingDate: '2013-12-08' };
const romeo2024 = { id: 'romeo-juliet-2024', slug: 'romeo-juliet-2024', title: 'Romeo + Juliet', category: 'broadway', previewsStartDate: '2024-09-26', openingDate: '2024-10-24', closingDate: '2025-02-16' };
const andJuliet = { id: 'and-juliet-2022', slug: 'and-juliet-2022', title: '& Juliet', category: 'broadway', previewsStartDate: '2022-10-28', openingDate: '2022-11-17' };
const SHOWS = [cabaret2014, cabaret2024, cabaretWE, romeo2013, romeo2024, andJuliet];

test('sameWork: a revival under a longer title is the same work; a fragment or a different word is not', () => {
  assert.equal(W.sameWork(cabaret2014, cabaret2024), true); // linked by originalProductionId below
  assert.equal(W.sameWork(t('Porgy and Bess'), t("The Gershwins' Porgy and Bess")), true);
  assert.equal(W.sameWork(t('Romeo and Juliet'), t('Romeo + Juliet')), true);
  assert.equal(W.sameWork(t('Romeo and Juliet'), t('& Juliet')), false);
  assert.equal(W.sameWork(t('Hair'), t('Hairspray')), false);
  assert.equal(W.sameWork(t('Doubt'), t('Doubt: A Parable')), true);
  // Ship-check false positives: one word is too weak; "on" is not noise.
  for (const [x, y] of [['Annie', 'Annie Get Your Gun'], ['Once', 'Once Upon a Mattress'], ['Home', 'Fun Home'], ['Big', 'Big Fish'], ['Our Town', 'On the Town'], ['Play On!', 'Slave Play'], ['Mean Girls', 'School Girls; Or, The African Mean Girls Play']]) {
    assert.equal(W.sameWork(t(x), t(y)), false, `${x} / ${y}`);
  }
  // Two originals are two works whatever the titles; one title is one work.
  assert.equal(W.sameWork({ title: 'SIX', id: 'six', isRevival: false }, { title: 'Six Degrees of Separation', id: 'six-degrees', isRevival: false }), false);
  assert.equal(W.sameWork({ title: 'Waitress', id: 'waitress-2016', isRevival: false }, { title: 'Waitress', id: 'waitress-2021', isRevival: false }), true);
  // A one-word title still matches when the other only adds a subtitle or the link says so.
  // A possessive credit before it is not a different work ("Bob Fosse's Dancin'"
  // parked every 2023 week); a possessive of the word itself still is.
  assert.equal(W.sameWork(t("Dancin'"), t("Bob Fosse's Dancin'")), true);
  assert.equal(W.sameWork(t('Cinderella'), t("Rodgers + Hammerstein's Cinderella")), true);
  assert.equal(W.sameWork(t('Annie'), t("Annie's Song")), false);
  assert.equal(W.sameWork(t('Cinderella'), t("Rodgers + Hammerstein's Cinderella Story")), false);
  // Review false positives: a one-word or article-led possessive is another work.
  for (const [x, y] of [['The Visit', "The Band's Visit"], ['The Women', "Jake's Women"], ['Cabaret', "Shakespeare's Cabaret"], ['Dream', "A Midsummer Night's Dream"]]) {
    assert.equal(W.sameWork(t(x), t(y)), false, `${x} / ${y}`);
  }
  assert.equal(W.sameWork({ title: 'Cabaret', id: 'cabaret-2014', originalProductionId: 'cabaret-1987' }, { title: 'Cabaret at the Kit Kat Club', id: 'cabaret-2024', originalProductionId: 'cabaret-1987' }), true);
});

test('runWeekWindow: previews less 7 days to closing plus 7; opening less 4 weeks when previews are unset; running shows run to now', () => {
  const day = 86400000;
  const w = W.runWeekWindow(cabaret2014, NOW);
  assert.equal(w.startMs, Date.parse('2014-03-14'));
  assert.equal(w.endMs, Date.parse('2015-04-05'));
  const noPreviews = W.runWeekWindow({ openingDate: '2021-09-02', closingDate: '2021-12-20' }, NOW);
  assert.equal(noPreviews.startMs, Date.parse('2021-09-02') - 35 * day);
  assert.equal(W.runWeekWindow(andJuliet, NOW).endMs, NOW + 7 * day);
  assert.equal(W.runWeekWindow({ title: 'x' }, NOW), null);
  assert.equal(W.weekInRun({ title: 'x' }, '2020-01-05', NOW), null);
});

test('grossesProductionFor: the matcher\'s pick is replaced by the run that holds the week', () => {
  // "Cabaret" exact-matches only cabaret-2014; a 2025 week belongs to the Kit Kat Club revival.
  assert.equal(W.grossesProductionFor(cabaret2014, '2025-01-05', SHOWS, NOW).slug, 'cabaret-2024');
  assert.equal(W.grossesProductionFor(cabaret2014, '2014-06-01', SHOWS, NOW).slug, 'cabaret-2014');
  // The 1998 revival is not in shows.json: no run holds 2002, so no slug.
  assert.equal(W.grossesProductionFor(cabaret2014, '2002-01-06', SHOWS, NOW), null);
  // "& Juliet" runs in 2024 too, but it is a different work.
  assert.equal(W.grossesProductionFor(romeo2013, '2024-10-06', SHOWS, NOW).slug, 'romeo-juliet-2024');
  // West End productions never take a League row.
  assert.equal(W.grossesProductionFor(cabaretWE, '2024-06-02', SHOWS, NOW).slug, 'cabaret-2024');
  // A show with no run dates keeps the matcher's pick; no week means no check.
  const undated = { slug: 'undated', title: 'Undated', category: 'broadway' };
  assert.equal(W.grossesProductionFor(undated, '2024-06-02', SHOWS, NOW), undated);
  assert.equal(W.grossesProductionFor(cabaret2014, null, SHOWS, NOW), cabaret2014);
});

test('historicalGrossesProduction: re-picks before the market check; medium needs a Broadway run of the work that week', () => {
  // A West End first match is re-picked to the Broadway run (Back To The Future case).
  assert.equal(W.historicalGrossesProduction('Cabaret', { show: cabaretWE, confidence: 'high' }, '2024-06-02', SHOWS, NOW).slug, 'cabaret-2024');
  // Medium is kept only when a Broadway production of the work held the week (The Best Man case).
  assert.equal(W.historicalGrossesProduction('Cabaret at the Kit Kat Club', { show: cabaret2014, confidence: 'medium' }, '2025-01-05', SHOWS, NOW).slug, 'cabaret-2024');
  assert.equal(W.historicalGrossesProduction('Cabaret', { show: cabaret2014, confidence: 'medium' }, '2002-01-06', SHOWS, NOW), null);
  assert.equal(W.historicalGrossesProduction('Cabaret', { show: cabaret2014, confidence: 'low' }, '2014-06-01', SHOWS, NOW), null);
  assert.equal(W.historicalGrossesProduction('Cabaret', null, '2014-06-01', SHOWS, NOW), null);
  // A row whose own title is another work never takes the fuzzy pick's slot.
  assert.equal(W.historicalGrossesProduction('Kit Kat Club Revue', { show: cabaret2014, confidence: 'medium' }, '2025-01-05', SHOWS, NOW), null);
  const bestMan = { id: 'tbm', slug: 'tbm', title: 'The Best Man', category: 'broadway', previewsStartDate: '2012-03-06', openingDate: '2012-04-01', closingDate: '2012-09-09' };
  assert.equal(W.mediumMatchProduction("Gore Vidal's The Best Man", bestMan, '2012-06-03', [bestMan], NOW)?.slug, 'tbm');
  const wolf = { id: 'wh', slug: 'wh', title: 'Wolf Hall Parts One & Two', category: 'broadway', previewsStartDate: '2015-03-20', openingDate: '2015-04-09', closingDate: '2015-07-05' };
  assert.equal(W.mediumMatchProduction('Wolf Hall: Parts 1 & 2', wolf, '2015-05-17', [wolf], NOW)?.slug, 'wh');
  assert.equal(W.mediumMatchProduction('Hall Pass: Parts 1 & 2', wolf, '2015-05-17', [wolf], NOW), null);
  const weOnly = { id: 'we-only', slug: 'we-only', title: 'West End Only', category: 'west-end', openingDate: '2020-01-01' };
  assert.equal(W.historicalGrossesProduction('West End Only', { show: weOnly, confidence: 'high' }, '2024-06-02', [...SHOWS, weOnly], NOW), null);
});

test('rekeyRowsToRuns: Cabaret weeks move to their own run, weeks no listed run held are set aside, a second pass is a no-op', () => {
  const h = { weeks: {
    '2002-01-06': { 'cabaret-2014': { gross: 1 } },
    '2014-06-01': { 'cabaret-2014': { gross: 2 } },
    '2025-01-05': { 'cabaret-2014': { gross: 3 } },
    '2025-01-12': { 'cabaret-2014': { gross: 4 }, 'cabaret-2024': { gross: 5 } },
  } };
  const st = rekeyRowsToRuns(h, SHOWS, NOW);
  assert.deepEqual(st.moved, [{ week: '2025-01-05', from: 'cabaret-2014', to: 'cabaret-2024' }]);
  assert.deepEqual(st.unplaced.map((u) => u.week), ['2002-01-06', '2025-01-12']);
  assert.deepEqual(h.weeks['2025-01-05'], { 'cabaret-2024': { gross: 3 } });
  // Never overwrites the target's own row for that week.
  assert.deepEqual(h.weeks['2025-01-12'], { 'cabaret-2024': { gross: 5 } });
  assert.deepEqual(h._unplacedRows, { '2002-01-06': { 'cabaret-2014': { gross: 1 } }, '2025-01-12': { 'cabaret-2014': { gross: 4 } } });
  assert.deepEqual(h.weeks['2014-06-01'], { 'cabaret-2014': { gross: 2 } });
  const again = rekeyRowsToRuns(h, SHOWS, NOW);
  assert.equal(again.moved.length + again.unplaced.length, 0);
});

test('rekeyRowsToRuns: a parked row returns once shows.json lists the production that ran that week', () => {
  const h = { weeks: { '2002-01-06': {} }, _unplacedRows: { '2002-01-06': { 'cabaret-2014': { gross: 1 } } } };
  const cabaret1998 = { id: 'cabaret-1998', slug: 'cabaret-1998', title: 'Cabaret', category: 'broadway', previewsStartDate: '1998-02-13', openingDate: '1998-03-19', closingDate: '2004-01-04' };
  const st = rekeyRowsToRuns(h, [...SHOWS, cabaret1998], NOW);
  assert.deepEqual(st.moved, [{ week: '2002-01-06', from: '_unplacedRows.cabaret-2014', to: 'cabaret-1998' }]);
  assert.deepEqual(h.weeks['2002-01-06'], { 'cabaret-1998': { gross: 1 } });
  assert.equal(h._unplacedRows, undefined);
});

test('repairGrossesHistory re-keys only when given shows (every history writer passes them)', () => {
  const mk = () => ({ weeks: { '2025-01-05': { 'cabaret-2014': { gross: 3 } } } });
  const without = mk();
  assert.equal(repairGrossesHistory(without).rowsMoved, 0);
  assert.ok(without.weeks['2025-01-05']['cabaret-2014']);
  const withShows = mk();
  assert.equal(repairGrossesHistory(withShows, { shows: SHOWS, nowMs: NOW }).rowsMoved, 1);
  assert.ok(withShows.weeks['2025-01-05']['cabaret-2024']);
});
