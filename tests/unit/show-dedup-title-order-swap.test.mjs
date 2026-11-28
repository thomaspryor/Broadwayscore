// BRO-4204 S5-T2: a double bill listed with its two titles in the opposite
// order is the same production. The Charing Cross pair existed under two ids
// ("The Human Voice / The Seven Deadly Sins" vs "The Seven Deadly Sins / The
// Human Voice") because every title check reads left-to-right. Per CLAUDE.md
// §15 the real functions are require()d — nothing is reimplemented here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate, isTitleOrderSwap } = require('../../scripts/lib/deduplication.js');

// The real Charing Cross rows (dates/venue as in shows.json).
const humanVoiceFirst = {
  id: 'the-human-voice-the-seven-deadly-sins-west-end-2026',
  title: 'The Human Voice / The Seven Deadly Sins',
  slug: 'the-human-voice-the-seven-deadly-sins-west-end',
  category: 'off-west-end',
  venue: 'Charing Cross Theatre',
  status: 'open',
  previewsStartDate: '2026-09-11',
  openingDate: '2026-09-12',
};
const sinsFirst = {
  id: 'the-seven-deadly-sins-the-human-voice-off-west-end-2026',
  title: 'The Seven Deadly Sins / The Human Voice',
  slug: 'the-seven-deadly-sins-the-human-voice-off-west-end',
  category: 'off-west-end',
  venue: 'Charing Cross Theatre',
  status: 'previews',
  previewsStartDate: '2026-09-11',
  openingDate: null,
};

test('Charing Cross double bill: the swapped title order at the same venue is a duplicate (both directions)', () => {
  const a = checkForDuplicate(sinsFirst, [humanVoiceFirst]);
  assert.equal(a.isDuplicate, true, 'Seven Deadly Sins-first listing must match the Human Voice-first row');
  assert.equal(a.existingShow.id, humanVoiceFirst.id);
  assert.match(a.reason, /title-order swap/);
  const b = checkForDuplicate(humanVoiceFirst, [sinsFirst]);
  assert.equal(b.isDuplicate, true, 'and the reverse direction');
  assert.equal(b.existingShow.id, sinsFirst.id);
});

test('the swap check is venue-gated: the same swapped pair at different venues is not merged by it', () => {
  const elsewhere = { ...sinsFirst, venue: 'Park Theatre' };
  const r = checkForDuplicate(elsewhere, [humanVoiceFirst]);
  assert.equal(r.isDuplicate, false, `different venues: ${r.reason}`);
});

test('the swap check still defers to isMultiProduction: a swapped pair whose run starts after the other closed is a new production', () => {
  const closed = { ...humanVoiceFirst, status: 'closed', closingDate: '2026-10-10' };
  const laterSeason = { ...sinsFirst, previewsStartDate: '2026-12-01' };
  const r = checkForDuplicate(laterSeason, [closed]);
  assert.equal(r.isDuplicate, false, `start-after-close wins: ${r.reason}`);
});

test('isTitleOrderSwap: " / ", "/", " & " and " and " separators; leading articles ignored; order-insensitive', () => {
  assert.equal(isTitleOrderSwap('The Human Voice / The Seven Deadly Sins', 'The Seven Deadly Sins / The Human Voice'), true);
  assert.equal(isTitleOrderSwap('Human Voice / Seven Deadly Sins', 'The Seven Deadly Sins / The Human Voice'), true, 'leading articles do not break the segment match');
  assert.equal(isTitleOrderSwap('Electra/Persona', 'Persona / Electra'), true, 'bare slash, like slugify/normalizeTitle treat it');
  assert.equal(isTitleOrderSwap('Bonnie & Clyde', 'Clyde & Bonnie'), true);
  assert.equal(isTitleOrderSwap('Romeo and Juliet', 'Juliet and Romeo'), true);
  assert.equal(isTitleOrderSwap('Cabaret / Chicago / Company', 'Company / Cabaret / Chicago'), true, 'three segments');
});

test('isTitleOrderSwap: never matches single-segment titles, differing segment sets, or different segment counts', () => {
  assert.equal(isTitleOrderSwap('Hamlet', 'Hamlet'), false, 'identical single titles are Check 1/5\'s job, not a swap');
  assert.equal(isTitleOrderSwap('Romeo and Juliet', 'Romeo and Rosaline'), false, 'one segment differs');
  assert.equal(isTitleOrderSwap('The Human Voice / The Seven Deadly Sins', 'The Human Voice'), false, 'one side is a single segment');
  assert.equal(isTitleOrderSwap('A / B / C', 'C / A'), false, 'segment count differs');
  assert.equal(isTitleOrderSwap('Grand Hotel', 'Hotel Grand'), false, 'word order inside one segment is not a segment swap');
  assert.equal(isTitleOrderSwap('', 'A / B'), false);
  assert.equal(isTitleOrderSwap(null, undefined), false);
});
