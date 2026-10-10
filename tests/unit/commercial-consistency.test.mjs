// Unit tests for scripts/lib/commercial-consistency.js (BRO-4985).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { closedStillTbd, recoupedModelDisagreements } = require('../../scripts/lib/commercial-consistency.js');

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
