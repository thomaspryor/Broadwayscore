// BRO-7239 class guard: every launched-hub show with a closingDate must say where it came from,
// and an open hub show may not carry a sourced closing date that has already passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const hubs = JSON.parse(fs.readFileSync('data/city-hubs.json', 'utf8')).hubs;
const raw = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
const shows = Array.isArray(raw) ? raw : raw.shows;
const finderCities = Object.entries(hubs).filter(([, h]) => h.finder && h.launched).map(([slug]) => slug);
const hubShows = shows.filter((s) => finderCities.includes(s.city));

test('hub shows with a closingDate carry a closingDateSource', { skip: hubShows.length === 0 }, () => {
  const bad = hubShows.filter((s) => s.closingDate && !s.closingDateSource).map((s) => s.id);
  assert.deepEqual(bad, []);
});

test('open hub shows are not past a sourced closing date', { skip: hubShows.length === 0 }, () => {
  const today = new Date().toISOString().slice(0, 10);
  const bad = hubShows
    .filter((s) => s.status !== 'closed' && s.closingDate && s.closingDateSource !== 'estimated' && s.closingDate < today)
    .map((s) => s.id);
  assert.deepEqual(bad, []);
});

test('ESTIMATED_RUN_DAYS matches between script and page logic', async () => {
  const { createRequire } = await import('node:module');
  const js = createRequire(import.meta.url)('../../scripts/lib/run-end-from-text.js').ESTIMATED_RUN_DAYS;
  const ts = fs.readFileSync('src/lib/city-hub.ts', 'utf8').match(/ESTIMATED_RUN_DAYS = (\d+)/)[1];
  assert.equal(String(js), ts);
});
