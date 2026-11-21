import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ownShowTextEvidence } = require('./own-show-text-evidence.js');

const dinosaurs = {
  title: 'The Dinosaurs',
  cast: ['Kathleen Chalfant', 'Elizabeth Marvel', 'April Matthis', 'Keilly McQuail', 'Mallory Portnoy', 'Maria Elena Ramirez'].map((name) => ({ name })),
};

test('5 of 6 listed cast named (BRO-5805 The Dinosaurs) is strong', () => {
  const text = 'There, Jane (April Matthis), the leader of one such group, ... Kathleen Chalfant is Joan; Elizabeth Marvel and Keilly McQuail round it out; Mallory Portnoy.';
  const r = ownShowTextEvidence(text, dinosaurs);
  assert.equal(r.castHits.length, 5);
  assert.equal(r.strong, true);
});

test('two named out of six is not strong; two of three is', () => {
  assert.equal(ownShowTextEvidence('April Matthis and Kathleen Chalfant', dinosaurs).strong, false);
  const small = { cast: ['Ann Lee', 'Bo Kim', 'Cy Park'] };
  assert.equal(ownShowTextEvidence('Ann Lee and Bo Kim', small).strong, true);
});

test('a title repeated many times is not evidence (same-title different production)', () => {
  const caroline = { title: 'Caroline', cast: [] };
  const text = 'Caroline, or Change. Caroline Thibodeaux. '.repeat(25);
  const r = ownShowTextEvidence(text, caroline);
  assert.equal(r.strong, false);
  assert.equal(r.castListed, 0);
});

test('diacritics, apostrophes and word boundaries', () => {
  const show = { cast: [{ name: 'Chloë Grace Moretz' }, { name: "Dan O'Brien" }, { name: 'Al Pacino' }] };
  const r = ownShowTextEvidence('Chloe Grace Moretz, Dan OBrien and Al Pacinos', show);
  assert.deepEqual(r.castHits, ['chloe grace moretz', 'dan obrien']);
  assert.equal(r.strong, true); // 2 of 3
});

test('missing or malformed inputs never throw or read as strong', () => {
  assert.equal(ownShowTextEvidence('', dinosaurs).strong, false);
  assert.equal(ownShowTextEvidence(null, null).strong, false);
  assert.equal(ownShowTextEvidence('Madonna Prince', { cast: ['Madonna', 'Prince', 7, null] }).strong, false);
});
