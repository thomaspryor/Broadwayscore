/**
 * BRO-4763: live-data coverage for the 1998 revival and its national tour.
 * Imported by tour-runtime-coverage.test.mjs in check-corpus-drift.yml's
 * Live-data assertions step. Kept out of the code-only unit batch.
 * Run directly: node --test tests/unit/sound-of-music-synopsis.test.mjs
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: live-data acceptance check for BRO-4763; verifies the synopsis backfill reached both productions
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { shows } = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));

for (const id of ['the-sound-of-music-1998', 'the-sound-of-music-tour-2025']) {
  test(`${id} has a synopsis of at least 40 characters`, () => {
    const show = shows.find(s => s.id === id);
    assert.ok(show, `missing show: ${id}`);
    assert.ok(typeof show.synopsis === 'string' && show.synopsis.trim().length >= 40,
      `${id}: missing synopsis (run the verified Wikipedia enricher, then tour inheritance)`);
  });
}
