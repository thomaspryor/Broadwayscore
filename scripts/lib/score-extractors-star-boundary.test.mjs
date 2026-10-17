// BRO-5295: the generic "N stars" patterns read digits and the word "star" out
// of unrelated prose. "1992 starring Meryl Streep" became 2/5 and the Death
// Becomes Her tour Her Campus rave was served as 40. These cases call the real
// extractor (no logic copied) on the false-positive shapes found by scanning
// the whole review corpus, plus the real ratings that must keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore } = require('./score-extractors.js');

// extractScore ignores text under ~100 chars for some paths; pad with neutral prose.
const PAD = ' A filler sentence about the musical, long enough that the extractor treats this as a full review body.';
const score = (s, outlet = 'some-outlet') => extractScore('', s + PAD, outlet);

test('"1992 starring ..." is not a 2-star rating (Her Campus, Death Becomes Her tour)', () => {
  assert.equal(score('The stage show is based on the movie from 1992 starring Meryl Streep and Goldie Hawn.', 'hercampus'), null);
});

test('year before "starring" never yields a rating (corpus false-positive shapes)', () => {
  for (const s of [
    'The original film from 2004 starring Lindsay Lohan.',
    'It premiered in Nottingham in 1952 starring the late Richard Attenborough.',
    'The movie in 2011 starring Robert Pattinson.',
    'Released 60 years ago in 1965 starring Julie Andrews.',
  ]) assert.equal(score(s), null, s);
});

test('digit-ending-a-number plus "Star..." word is not a rating', () => {
  assert.equal(score('© 2014 StarTribune. All rights reserved.'), null);
  assert.equal(score('Over the next months some 14 stars including Jimmy Fallon appeared.'), null);
});

test('"N out of 5.0 stars" reads N, not the trailing 5.0 (shinylife served 5/5 for a 4.0)', () => {
  const r = score('Park Theatre 4.0 out of 5.0 stars4.0 The Importance of Being Oscar is a delight.');
  assert.equal(r && r.originalScore, '4/5');
  const r3 = score('Playhouse 3.0 out of 5.0 stars3.0 Jane Eyre is currently running.');
  assert.equal(r3 && r3.originalScore, '3/5');
});

test('real ratings still extract', () => {
  assert.equal(score('Our verdict: 4 stars. A fine night out.').originalScore, '4/5');
  assert.equal(score('Rating: 4.5 stars. Wonderful.').originalScore, '4.5/5');
  assert.equal(score('3/5 stars - uneven but charming.').originalScore, '3/5');
  assert.equal(score('4 out of 5 stars').originalScore, '4/5');
  // sentence ends right before the number (no space): still a rating
  assert.equal(score('Syal had me very moved.4 stars from me.').originalScore, '4/5');
  // Time Out glues the next word onto "stars"
  assert.equal(score('A Streetcar Named Desire Review\n\n3 out of 5 starsPatsy Ferran and Paul').originalScore, '3/5');
});

test('"of N stars" in ordinary prose still reads as a rating; only "out of N stars" is the denominator', () => {
  assert.equal(score('A show worthy of 4 stars, easily.').originalScore, '4/5');
  assert.equal(score('In 1992, the show earned 4 stars from the Times.').originalScore, '4/5');
  assert.equal(score('Verdict: 2 out of 5 stars').originalScore, '2/5');
});

test('"N out of 50" is not a rating, and "N of 5 stars" is not read as 5/5', () => {
  assert.equal(score('4 stars. Only 1 out of 50 shows manage this.').originalScore, '4/5');
  assert.equal(score('Verdict: 4 of 5 stars'), null);
  assert.equal(score('Rating: 4.0 out of 5.0 stars').originalScore, '4/5');
});
