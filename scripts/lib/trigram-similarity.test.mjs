// BRO-7391: a truncated syndicated copy must read as the same article.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { trigramSimilarity, trigramContainment } = createRequire(import.meta.url)('./trigram-similarity.js');

// Shape of romeo-and-juliet-2013: the Chicago Tribune ran a ~56-word prefix of
// Variety's ~587-word Marilyn Stasio review (written fresh here, not the review).
const longText = Array.from({ length: 40 }, (_, i) =>
  `Sentence number ${i} talks about lovers casting staging design pacing number${i} feuding families verona balcony.`).join(' ');
const prefix = longText.split(' ').slice(0, 60).join(' ') + ' [...]';

test('Jaccard misses a short prefix copy (why containment exists)', () => {
  assert.ok(trigramSimilarity(prefix, longText) < 50);
});

test('containment sees the prefix inside the full text, either argument order', () => {
  const a = trigramContainment(prefix, longText);
  assert.ok(a.containment >= 90, `got ${a.containment}`);
  assert.equal(a.shorter, 1);
  const b = trigramContainment(longText, prefix);
  assert.equal(b.containment, a.containment);
  assert.equal(b.shorter, 2);
});

test('unrelated reviews of the same show are not contained', () => {
  const other = Array.from({ length: 30 }, (_, i) =>
    `A different critic writes paragraph ${i} about orchestra seats intermission ticket price${i} and lighting cues.`).join(' ');
  assert.ok(trigramContainment(other, longText).containment < 20);
});

test('fragments under minWords never count (stock phrases are not syndication)', () => {
  assert.equal(trigramContainment('Romeo and Juliet opened tonight at the Richard Rodgers Theatre', longText).containment, 0);
});
