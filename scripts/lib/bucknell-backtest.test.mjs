// Tests for scripts/lib/bucknell-backtest.js (BRO-6143). Requires the real module.
// Run: node --test scripts/lib/bucknell-backtest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { studyVerdict, normalizeTitle, matchShow, matchShowDetailed, neverOpened, commercialFor, runBacktest, accuracy, alwaysNoBaseline, splitNoCommercial } = require('./bucknell-backtest.js');
const study = require('../../data/analysis/bucknell-recoupment-2008-2017.json');

test('every study label maps to a verdict', () => {
  for (const row of study.shows) assert.ok(studyVerdict(row.classification), row.title);
  assert.deepEqual(studyVerdict('Plausible'), { recouped: true, firm: false });
  assert.deepEqual(studyVerdict('No - Grosses below Cap'), { recouped: false, firm: true });
  assert.equal(studyVerdict('Maybe'), null);
});

test('snapshot matches the published counts (28 press recoupments, 6 plausible, 133 shows)', () => {
  const n = (c) => study.shows.filter((s) => s.classification === c).length;
  assert.equal(study.shows.length, 133);
  assert.equal(n('Yes - Press'), 28);
  assert.equal(n('Plausible'), 6);
});

test('normalizeTitle drops revival years, "the musical" and leading articles', () => {
  assert.equal(normalizeTitle('Les Misérables (2014)'), 'les miserables');
  assert.equal(normalizeTitle('A Bronx Tale The Musical'), 'bronx tale');
  assert.equal(normalizeTitle('A Gentleman\'s Guide to Love & Murder'), 'gentleman s guide to love and murder');
});

const shows = [
  { id: 'les-miserables-2014', title: 'Les Misérables', openingDate: '2014-03-23', closingDate: '2016-09-04' },
  { id: 'les-miserables-2006', title: 'Les Misérables', openingDate: '2006-11-09', closingDate: '2008-01-06' },
  { id: 'elf-2012', title: 'Elf', openingDate: '2012-11-09', closingDate: '2013-01-05' },
  { id: 'rodgers-hammersteins-cinderella-2013', title: "Rodgers + Hammerstein's Cinderella", openingDate: '2013-03-03' },
  { id: 'ghost-2012', title: 'Ghost the Musical', openingDate: '2012-04-23' },
];

test('matchShow picks the revival by opening date', () => {
  assert.equal(matchShow({ title: 'Les Misérables (2014)', opening: '2014-03-23' }, shows).id, 'les-miserables-2014');
});

test('matchShow joins a merged holiday run by closing date', () => {
  assert.equal(matchShow({ title: 'Elf - The Musical', opening: '2010-11-14', closing: '2013-01-05' }, shows).id, 'elf-2012');
});

test('matchShow accepts a longer billing title on the same opening night', () => {
  assert.equal(matchShow({ title: 'Cinderella', opening: '2013-03-03' }, shows).id, 'rodgers-hammersteins-cinderella-2013');
});

test('matchShow does not match a different show that opened the same week', () => {
  assert.equal(matchShow({ title: 'Nice Work If You Can Get It', opening: '2012-04-24' }, shows), null);
});

test('commercialFor resolves by slug, then _resolvedId', () => {
  assert.equal(commercialFor({ id: 'x', slug: 'ghost' }, { ghost: { a: 1 } }).key, 'ghost');
  assert.equal(commercialFor({ id: 'ghost-2012' }, { g: { _resolvedId: 'ghost-2012' } }).key, 'g');
  assert.equal(commercialFor(null, {}), null);
});

test('runBacktest tallies firm and soft labels separately and flags conflicts', () => {
  const rows = [
    { title: 'Les Misérables (2014)', opening: '2014-03-23', classification: 'Yes - Press' },
    { title: 'Ghost the Musical', opening: '2012-04-23', classification: 'Plausible' },
  ];
  const comm = {
    'les-miserables-2014': { recouped: true, modelRecouped: true },
    'ghost-2012': { recouped: null, modelRecouped: false, modelRecoupmentPct: [10, 40, 70] },
  };
  const r = runBacktest(rows, shows, comm);
  assert.deepEqual(r.reported.firm, { tp: 1, fp: 0, fn: 0, tn: 0, unknown: 0 });
  assert.deepEqual(r.model.soft, { tp: 0, fp: 0, fn: 1, tn: 0, unknown: 0 });
  assert.equal(r.rows[1].modelConflict, true);
  assert.equal(r.rows[1].modelPct, 40);
  assert.equal(accuracy(r.model.firm), 1);
});

test('matchShowDetailed names the rule that matched', () => {
  assert.equal(matchShowDetailed({ title: 'Les Misérables (2014)', opening: '2014-03-23' }, shows).rule, 'opening');
  assert.equal(matchShowDetailed({ title: 'Elf - The Musical', opening: '2010-11-14', closing: '2013-01-05' }, shows).rule, 'closing');
  assert.equal(matchShowDetailed({ title: 'Cinderella', opening: '2013-03-03' }, shows).rule, 'contained');
});

test('neverOpened reads the study notes; the snapshot has the 4 known cases', () => {
  const titles = study.shows.filter(neverOpened).map((s) => s.title).sort();
  assert.deepEqual(titles, ['Funny Girl', 'Godspell (2008)', 'Love Never Dies', 'Nerds']);
});

test('runBacktest reports labels it does not know instead of dropping them silently', () => {
  const r = runBacktest([{ title: 'Ghost the Musical', opening: '2012-04-23', classification: 'Pending' }], shows, {});
  assert.deepEqual(r.unlabeled, ['Ghost the Musical']);
  assert.equal(r.rows.length, 0);
});

test('alwaysNoBaseline is the share of rows the study calls not recouped', () => {
  assert.equal(alwaysNoBaseline({ tp: 1, fp: 0, fn: 1, tn: 2, unknown: 5 }), 0.5);
  assert.equal(alwaysNoBaseline({ tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0 }), null);
});

test('runBacktest does not score an ai-estimated record as the model', () => {
  const rows = [{ title: 'Les Misérables (2014)', opening: '2014-03-23', classification: 'No - Press' }];
  const comm = { 'les-miserables-2014': { recouped: true, modelRecouped: true, modelMethod: 'ai-estimated' } };
  const r = runBacktest(rows, shows, comm);
  assert.equal(r.model.passthrough, 1);
  assert.deepEqual(r.model.firm, { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0 });
  assert.equal(r.rows[0].modelConflict, false);
  assert.equal(r.rows[0].reportedConflict, true);
});

test('splitNoCommercial separates documented no-source shows and flags stale entries (BRO-6182)', () => {
  const rows = [
    { showId: 'a', commercialKey: null },
    { showId: 'b', commercialKey: null },
    { showId: 'c', commercialKey: 'c' },
    { showId: null, commercialKey: null },
  ];
  const out = splitNoCommercial(rows, { a: { reason: 'x' }, c: { reason: 'now has a record' }, gone: { reason: 'no page' } });
  assert.deepEqual(out.documented.map((r) => r.showId), ['a']);
  assert.deepEqual(out.openRows.map((r) => r.showId), ['b']);
  assert.deepEqual(out.staleDoc.sort(), ['c', 'gone']);
  assert.deepEqual(splitNoCommercial(rows, undefined).openRows.map((r) => r.showId), ['a', 'b']);
});
