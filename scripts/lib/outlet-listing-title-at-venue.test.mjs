// BRO-7821: The Reviews Hub headline "<Show> – <Venue>, <City>" (no "review" word) must match a
// credit-less short-title show at its own venue. Nero (4 letters) was missed by the first pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { findMatchingShows } = createRequire(import.meta.url)('./outlet-listing-helpers.js');

const nero = { id: 'nero-off-west-end-2026', title: 'Nero', venue: 'Southwark Playhouse', openingDate: '2026-11-06', previewsStartDate: '2026-11-02', closingDate: '2026-12-05', status: 'open', category: 'off-west-end', creativeTeam: [], cast: [] };
const ids = (h, slug, pub) => findMatchingShows(h, slug, [nero], '', { publishDate: pub, nowMs: Date.parse(pub) }).map((s) => s.id);

test('Reviews Hub "Nero – Southwark Playhouse Elephant, London" matches Nero', () => {
  assert.deepEqual(ids('Nero – Southwark Playhouse Elephant, London', '/nero-southwark-playhouse-elephant-london/', '2026-11-08'), [nero.id]);
});
test('news about the title at the venue does not match', () => {
  assert.deepEqual(ids('Nero cast announced for Southwark Playhouse Elephant', '/nero-cast-announced-for-southwark-playhouse-elephant/', '2026-11-08'), []);
});
test('same shape at another venue does not match', () => {
  assert.deepEqual(ids('Nero – Hampstead Theatre, London', '/nero-hampstead-theatre-london/', '2026-11-08'), []);
});
test('same shape outside the run window does not match', () => {
  assert.deepEqual(ids('Nero – Southwark Playhouse Elephant, London', '/nero-southwark-playhouse-elephant-london/', '2027-03-01'), []);
});
