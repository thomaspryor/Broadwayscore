// Regression guard for BRO-2281: "I'm Every Woman, The Chaka Khan Musical"
// (Peacock/Hackney Empire run) had a stale venue field. The Peacock Theatre
// run was cancelled for building works and relocated on short notice to
// Hackney Empire (20-25 March 2026) — the show was added/enriched from the
// original Peacock announcement before that relocation was reflected back
// into shows.json. Reads the real data/shows.json rather than a copied
// fixture, so this fails again if the field ever regresses (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

function findShow(id) {
  return loadShows().find((s) => s.id === id);
}

test('BRO-2281: relocated Hackney Empire run carries the actual venue, not the cancelled Peacock Theatre booking', () => {
  const show = findShow('im-every-woman-the-chaka-khan-musical-west-end-2026');
  assert.ok(show, 'show im-every-woman-the-chaka-khan-musical-west-end-2026 must exist in shows.json');
  assert.equal(show.venue, 'Hackney Empire');
});

test('BRO-2281: the unrelated Troubadour Wembley Park run of the same title keeps its own venue', () => {
  // Distinct show record (Aug-Sep 2026) — confirmed during BRO-626 research to
  // be a separate production from the West End/Hackney Empire run above.
  // Guards against a future fix accidentally touching the wrong record by id
  // prefix collision.
  const show = findShow('im-every-woman-off-west-end-2026');
  assert.ok(show, 'show im-every-woman-off-west-end-2026 must exist in shows.json');
  assert.equal(show.venue, 'Troubadour Wembley Park Theatre');
});
