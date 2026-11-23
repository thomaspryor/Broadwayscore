import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('./press-night-readiness-gaps.js');
const { embargoInfo } = require('./press-night-record.js');

const NOW = Date.parse('2026-11-23T17:00:00Z');
const show = (id, category, openingDate, extra = {}) => ({ id, title: id, category, openingDate, status: 'upcoming', ...extra });
const embargoAt = (s) => embargoInfo(s).at;

test('regional and touring openings without an hour are sweep-only, not listed (BRO-8146)', () => {
  const shows = [show('r', 'regional', '2026-11-24'), show('t', 'tour', '2026-11-25')];
  assert.deepEqual(lib.unwatchedOpenings(shows, { nowMs: NOW, embargoAt }), []);
  const [row] = lib.pressNightReadinessResults({ shows, overrides: {}, nowMs: NOW, embargoAt });
  assert.equal(row.status, 'pass');
});

test('a lane market with no embargo hour is still named', () => {
  const shows = [show('x', 'mystery-market', '2026-11-24'), show('b', 'broadway', '2026-11-24')];
  const out = lib.unwatchedOpenings(shows, { nowMs: NOW, embargoAt });
  assert.deepEqual(out.map((u) => u.id), ['x']);
});

test('an embargoAt that throws is unwatched for a non-sweep-only market', () => {
  const out = lib.unwatchedOpenings([show('b', 'broadway', '2026-11-24')], { nowMs: NOW, embargoAt: () => { throw new Error('boom'); } });
  assert.equal(out.length, 1);
});
