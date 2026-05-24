// Tests for scripts/lib/cast-extraction-guards.js — the post-extraction
// validator used by backfill-cast-web.js to reject wrong-show / corrupted
// cast extractions. See feedback_orphan_cast_invisible_by_design.md for
// the 12 historical contamination cases this catches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateCastExtraction } = require('../../scripts/lib/cast-extraction-guards.js');

test('rejects Met Opera contamination (Kavalier-Clay case)', () => {
  const cast = [
    { name: 'Anna Netrebko', role: 'Abigaille' },
    { name: 'Lise Davidsen', role: 'Isolde' },
    { name: 'Michael Spyres', role: 'Tristan' },
    { name: 'Corinne Winters', role: 'Cavalleria rusticana' },
  ];
  const r = validateCastExtraction(cast, 'The Amazing Adventures of Kavalier and Clay');
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /opera-role-contamination/);
});

test('rejects TV-show role contamination (Much Ado case)', () => {
  const cast = [
    { name: 'Stevie Basaula', role: 'Isaac Baptiste' },
    { name: 'Shobu Kapoor', role: 'Bridgerton' },
    { name: 'Martina Laird', role: 'Unforgotten' },
  ];
  const r = validateCastExtraction(cast, 'Much Ado About Nothing');
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(','), /tv-role-contamination/);
});

test('rejects LASTNAME-FIRSTNAME name swap (Pride case)', () => {
  const cast = [
    { name: 'Jenkins Gethin', role: 'Darren' },
    { name: 'Williams Margaret', role: 'Matthew' },
    { name: 'Lumsden Mark', role: 'Kirsty' },
  ];
  const r = validateCastExtraction(cast, 'Pride');
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(','), /name-swap-pattern/);
});

test('passes clean cast and strips column-header roles', () => {
  const cast = [
    { name: 'Dylan Baker', role: 'Original' },     // column header → role stripped
    { name: 'Madeline Brewer', role: 'Raf Night' },
    { name: 'Hamish Linklater', role: 'Benjamin Braxton' },
  ];
  const r = validateCastExtraction(cast, 'The Disappear');
  assert.equal(r.ok, true);
  assert.deepEqual(r.cleaned[0], { name: 'Dylan Baker' });
  assert.equal(r.cleaned[1].role, 'Raf Night');
  assert.equal(r.cleaned[2].role, 'Benjamin Braxton');
});

test('passes legitimate UK/Irish cast', () => {
  const cast = [
    { name: 'Nicola Coughlan', role: 'Pegeen Mike' },
    { name: 'Éanna Hardwicke', role: 'Christy Mahon' },
    { name: 'Siobhán McSweeney', role: 'Widow Quin' },
  ];
  const r = validateCastExtraction(cast, 'The Playboy of the Western World');
  assert.equal(r.ok, true);
  assert.equal(r.reasons.length, 0);
});

test('allows opera-titled roles when show IS an opera', () => {
  const cast = [
    { name: 'Anna Netrebko', role: 'Abigaille' },
    { name: 'Lise Davidsen', role: 'Isolde' },
  ];
  const r = validateCastExtraction(cast, 'Met Opera 2025-26 Season');
  assert.equal(r.ok, true);
});

test('rejects empty cast', () => {
  const r = validateCastExtraction([], 'Anything');
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['empty']);
});

test('single column-header role does not trigger swap/contamination', () => {
  // Single name like "Williams Margaret" might be a real edge case, not a swap
  // pattern — require ≥2 to flag.
  const cast = [
    { name: 'Williams Margaret', role: 'Catherine' },
    { name: 'Nicola Coughlan', role: 'Pegeen Mike' },
  ];
  const r = validateCastExtraction(cast, 'Test Show');
  assert.equal(r.ok, true);
});
