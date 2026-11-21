// Unit tests for scripts/lib/commercial-consistency.js (BRO-4985).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { closedStillTbd, recoupedModelDisagreements, recoupedDateNoteConflicts } = require('../../scripts/lib/commercial-consistency.js');

const NOW = Date.parse('2026-10-10T12:00:00Z');

test('closedStillTbd flags closed TBD records older than 60 days only', () => {
  const records = {
    'our-town': { designation: 'TBD', showId: 'our-town-2024' },
    beaches: { designation: 'TBD' },
    'dog-day-afternoon': { designation: 'TBD' },
    hamilton: { designation: 'Miracle', showId: 'hamilton-2015' },
    'running-show': { designation: 'TBD' },
  };
  const shows = [
    { id: 'our-town-2024', slug: 'our-town', status: 'closed', closingDate: '2025-01-19' },
    { id: 'beaches-2026', slug: 'beaches', status: 'closed', closingDate: '2026-05-24' },
    { id: 'dog-day-2026', slug: 'dog-day-afternoon', status: 'closed', closingDate: '2026-09-01' }, // 39 days
    { id: 'hamilton-2015', slug: 'hamilton', status: 'closed', closingDate: '2020-01-01' },
    { id: 'running-show', slug: 'running-show', status: 'open', closingDate: null },
  ];
  const out = closedStillTbd(records, shows, { now: NOW });
  assert.deepEqual(out.map(o => o.slug), ['our-town', 'beaches']);
});

test('recoupedModelDisagreements lists both directions and skips missing model', () => {
  const out = recoupedModelDisagreements({
    gutenberg: { recouped: true, modelRecouped: false, modelDataQuality: 'low' },
    'parade-2023': { recouped: false, modelRecouped: true },
    hamilton: { recouped: true, modelRecouped: true },
    'no-model': { recouped: true },
  });
  assert.deepEqual(out.map(o => o.slug), ['gutenberg', 'parade-2023']);
  assert.equal(out[0].modelDataQuality, 'low');
});

test('recoupedModelDisagreements ignores a model range that straddles 100%', () => {
  // Real values, commercial.json 2026-10-10.
  const out = recoupedModelDisagreements({
    gutenberg: { recouped: true, modelRecouped: false, modelRecoupmentPct: [67.7, 99.8, 129.4] },
    'frozen-2018': { recouped: false, modelRecouped: true, modelRecoupmentPct: [67.9, 127.5, 168.3] },
    'the-music-man-2022': { recouped: false, modelRecouped: true, modelRecoupmentPct: [169.2, 198.3, 228.2] },
    'model-says-short': { recouped: true, modelRecouped: false, modelRecoupmentPct: [40, 55, 80] },
  });
  assert.deepEqual(out.map(o => o.slug), ['the-music-man-2022', 'model-says-short']);
});

test('recoupedDateNoteConflicts flags a note month that differs from recoupedDate (BRO-5073)', () => {
  const records = {
    six: { recoupedDate: '2022-12', notes: 'Strong grosses. Recouped as of Dec 2021 (announced Mar 2023).' },
    agree: { recoupedDate: '2022-12', notes: 'Recouped in December 2022.' },
    either: { recoupedDate: '2019-03-05', notes: 'Recouped Mar 5, 2019; earlier reports said recouped Feb 2019.' },
    yearOnly: { recoupedDate: '2019', notes: 'Recouped in May 2019.' },
    none: { recoupedDate: '2020-01', notes: 'Opened in Apr 2018.' },
    noDate: { notes: 'Recouped Dec 2021.' },
  };
  assert.deepEqual(recoupedDateNoteConflicts(records), [{ slug: 'six', recoupedDate: '2022-12', note: 'Recouped as of Dec 2021' }]);
});

test('recoupedDateNoteConflicts reads real note phrasings and skips non-recoup dates (BRO-5073)', () => {
  const flags = (notes, recoupedDate) => recoupedDateNoteConflicts({ x: { recoupedDate, notes } }).length;
  // Parenthetical, decimal amount, long lead-in, "Month, year" and yearless "Month day" all parse.
  assert.equal(flags('Recouped about 16 months after opening (May 2023).', '2023-09'), 1);
  assert.equal(flags('Recouped about 16 months after opening (May 2023).', '2023-05'), 0);
  assert.equal(flags('Recouped its $16 million investment in December 2014', '2015-06'), 1);
  assert.equal(flags('Recouped its $1.5M investment in May, 2023', '2023-01'), 1);
  assert.equal(flags('Recouped its $22M investment in the week ending Dec 28', '2025-03'), 1);
  assert.equal(flags('Recouped its $22M investment in the week ending Dec 28', '2024-12'), 0);
  // Opening dates, future tense and "decade" are not recoupment dates.
  assert.equal(flags('Recouped 8 months after March 2017 opening', '2017-11'), 0);
  assert.equal(flags('Expected to recoup by May 2024', '2024-09'), 0);
  assert.equal(flags('Will recoup within a decade 2010', '2012-01'), 0);
});
