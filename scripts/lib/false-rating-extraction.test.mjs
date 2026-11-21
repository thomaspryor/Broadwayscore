// BRO-4318: two extractor classes that stored a rating the critic never gave, found
// while resolving the "sided with LLM" adjudications. Synthetic text in the same
// shape as the stored pages; no review text is copied.
//   1. word-stars: "the powerful work of its two stars." (the two lead actors) was
//      stored as 2/5 on a rave (Chester Bailey, Lighting & Sound America).
//   2. letter-grade: HuffPost's ratings list runs "no ratingA Month In The Country"
//      together; the bare keyword read the next title's "A" as grade A (Misery,
//      Wolf Hall: stored A on a one-star and a two-and-a-half-star review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore, extractGenericStarRating, extractGenericLetterGrade, extractNYPostScore } = require('./score-extractors.js');

const filler = 'The production opens on a bare stage and the cast moves through the story at a steady pace. '.repeat(12);

test('possessive cast prose ("its two stars.") is not a word-star rating', () => {
  for (const line of [
    'The evening is distinguished by the extraordinarily powerful work of its two stars.',
    'The play rests on the performances of their two stars.',
    'It thrives on the chemistry between its two stars, and they deliver.',
  ]) {
    const t = `${filler}\n\n${line}`;
    assert.equal(extractGenericStarRating(t, t), null, line);
    assert.equal(extractScore('', t, 'lighting-and-sound-america'), null, line);
  }
});

test('real spelled-out verdicts still read after the possessive guard', () => {
  for (const [line, want] of [
    ['It deserves every one of its five stars.', '5/5 stars'],
    ['Verdict: Four stars.', '4/5 stars'],
    ['Three stars.', '3/5 stars'],
  ]) {
    const t = `${filler}\n\n${line}`;
    const r = extractGenericStarRating(t, t);
    assert.equal(r && r.originalScore, want, line);
  }
});

test('"no ratingA Month..." run-together list text is not grade A', () => {
  const t = `Other shows this season: Let The Right One In **Da no ratingA Month In The Country ** 1/2Parade ***\n${filler}`;
  assert.equal(extractGenericLetterGrade('', t), null);
  assert.equal(extractNYPostScore('', t), null);
  assert.equal(extractScore('', t, 'huffpost'), null);
});

test('real keyword grades still extract', () => {
  assert.equal(extractGenericLetterGrade('', 'Grade: B+').originalScore, 'B+');
  assert.equal(extractGenericLetterGrade('', 'My rating: A-').originalScore, 'A-');
  assert.equal(extractGenericLetterGrade('', 'GRADE A').originalScore, 'A');
  assert.equal(extractGenericLetterGrade('', 'Rating:C').originalScore, 'C');
  assert.equal(extractNYPostScore('', 'Grade: B').originalScore, 'B');
});
