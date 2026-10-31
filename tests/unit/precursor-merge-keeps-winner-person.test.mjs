// BRO-5817: a per-category precursor write must not drop the year-page
// winnerPersonName/winnerEntries from a stored year entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mergeYearEntry } = require('../../scripts/lib/precursor-wikipedia');

test('person-keyed scrape does not replace a year-page entry; nominees are unioned', () => {
  const stored = { year: 2026, winner: 'Giant', winnerPersonName: 'Someone', nominees: ['Giant', 'A'] };
  const scraped = { year: 2026, winner: 'Someone', nominees: ['Someone', 'B'] };
  const out = mergeYearEntry(stored, scraped);
  assert.equal(out.winner, 'Giant');
  assert.equal(out.winnerPersonName, 'Someone');
  assert.deepEqual(out.nominees, ['Giant', 'A', 'Someone', 'B']);
});

test('a year-page scrape (carries winnerPersonName) still overrides the stored entry', () => {
  const stored = { year: 2026, winner: 'Giant', winnerPersonName: 'Old', nominees: ['Giant'] };
  const scraped = { year: 2026, winner: 'Giant', winnerPersonName: 'New', nominees: ['Giant', 'C'] };
  assert.deepEqual(mergeYearEntry(stored, scraped), scraped);
});

test('no stored person fields: the scrape wins as before', () => {
  const scraped = { year: 2020, winner: 'X', nominees: ['X'] };
  assert.equal(mergeYearEntry({ year: 2020, winner: 'Y', nominees: [] }, scraped), scraped);
  assert.equal(mergeYearEntry(undefined, scraped), scraped);
});

test('checked-in precursor files: no year entry has winnerEntries without a winnerPersonName', () => {
  for (const f of fs.readdirSync(new URL('../../data/precursors/', import.meta.url)).filter(n => n.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(new URL(`../../data/precursors/${f}`, import.meta.url))).data || {};
    for (const [cat, arr] of Object.entries(d)) if (Array.isArray(arr)) for (const e of arr) {
      if (e.winnerEntries?.length) assert.ok(e.winnerPersonName, `${f} ${cat} ${e.year}`);
    }
  }
});
