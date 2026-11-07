// BRO-5607: the weekly cost a reported recoupment date implies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { impliedRecoupNut } = require('./implied-recoup-cost.js');

const show = { type: 'play', previewsStartDate: '2024-09-26', openingDate: '2024-10-24', closingDate: '2025-02-16' };
const comm = { recouped: true, recoupedDate: '2025-02', recoupedSource: 'Variety (Feb 17, 2025): the production recouped its capitalization', capitalization: 7000000 };
const weeklyDates = Array.from({ length: 21 }, (_, i) => new Date(Date.parse('2024-09-29') + i * 7 * 86400000).toISOString().slice(0, 10));
// A toy model: profit falls linearly with the nut; 100% at a $530K nut.
const pctAt = (nut) => 100 + (530000 - nut) / 2000;
const ctx = (over = {}) => ({ currentNut: 650000, category: 'play', citedCost: false, weeklyDates, pctAt, ...over });

test('a reported recoupment pins the nut where the model reads 100% on the date', () => {
  const r = impliedRecoupNut(show, comm, ctx());
  assert.equal(r.date, '2025-02-16'); // the announcement day, clamped to closing
  assert.ok(Math.abs(r.nut - 530000) < 50, `nut ${r.nut}`);
});

test('a cited reported cost wins, except on a star-driven play', () => {
  assert.equal(impliedRecoupNut(show, comm, ctx({ citedCost: true })).skip, 'cited reported cost');
  assert.ok(impliedRecoupNut(show, comm, ctx({ citedCost: true, category: 'playStar' })).nut > 0);
});

test('musicals, credit-counted, late and long-tail recoupments are skipped', () => {
  assert.equal(impliedRecoupNut(show, comm, ctx({ category: 'musical' })).skip, 'not a play');
  assert.equal(impliedRecoupNut(show, { ...comm, recoupedSource: 'Playbill (Feb 17, 2025): recouped its capitalization including the tax credit' }, ctx()).skip, 'recouped with the tax credit');
  assert.equal(impliedRecoupNut(show, { ...comm, recoupedDate: '2026-03' }, ctx()).skip, 'recoupment announced well after closing');
  assert.match(impliedRecoupNut({ ...show, closingDate: '2027-06-01' }, comm, ctx()).skip, /weeks after recoupment/);
  assert.equal(impliedRecoupNut(show, { ...comm, recouped: false }, ctx()).skip, 'not a reported recoupment');
});

test('no nut inside the band reaching 100% is a skip, not a guess', () => {
  assert.match(impliedRecoupNut(show, comm, ctx({ pctAt: () => 40 })).skip, /no nut in the band/);
});

test('an implied cost keeps the record\'s data quality: a fitted nut is not a reported one', () => {
  const { calculateRecoupment } = require('./recoupment-model.js');
  const run = { slug: 'x', type: 'play', venue: 'Helen Hayes Theater', previewsStartDate: '2023-11-29', openingDate: '2023-12-18', closingDate: '2024-06-30', status: 'closed' };
  const weekly = {};
  for (let i = 0; i < 30; i++) weekly[new Date(Date.UTC(2023, 11, 3 + 7 * i)).toISOString().slice(0, 10)] = { gross: 600000, performances: 8, attendance: 4000 };
  const allTime = { gross: 18000000, performances: 240, attendance: 120000 };
  const rec = { designation: 'Easy Winner', recouped: true, recoupedDate: '2024-04-15', recoupedSource: 'Variety (Apr 15, 2024): the production recouped its capitalization', capitalization: 3750000 };
  const plain = calculateRecoupment(run, rec, allTime, weekly, { impliedCost: false });
  const r = calculateRecoupment(run, rec, allTime, weekly);
  assert.ok(r.impliedNut > 0, r.warnings.join(' | '));
  assert.equal(r.weeklyFixedCostSource, 'implied');
  assert.equal(r.dataQuality, plain.dataQuality);
});
