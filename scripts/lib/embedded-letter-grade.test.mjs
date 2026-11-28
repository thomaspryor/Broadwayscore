import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { extractEmbeddedLetterGrade: ex } = require('./embedded-letter-grade.js');

test('real grades still extract', () => {
  assert.equal(ex('A fine night out. Grade: B+').grade, 'B+');
  assert.equal(ex('Overall rating: A- for effort. More text here.').grade, 'A-');
  assert.equal(ex('Lots of prose here that ends with the grade B').grade, 'B');
  assert.equal(ex('Review text continues and then rating C').grade, 'C');
});

test('BRO-8350: article "a" after a word ending in rating/grade is not a grade', () => {
  assert.equal(ex('calculating a stronger head for business than most'), null);
  assert.equal(ex('She is operating a business; an upgrade a day'), null);
  assert.equal(ex('Reviewers give it a rating a notch above average'), null);
  assert.equal(ex('the production earns a grade: a mixed bag'), null);
});

test('musical score and bare "grade" are not grades', () => {
  assert.equal(ex('The score A major sweeps through the overture'), null);
  assert.equal(ex('It is Grade B material'), null);
});

test('a lowercase end-of-text letter is not a grade', () => {
  assert.equal(ex('and that is what makes it such a'), null);
});

test('both fallback scorers use the shared helper, not their own regex', () => {
  for (const f of ['../fix-default-scores.js', '../score-all-unscored.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /embedded-letter-grade/, f);
    assert.doesNotMatch(src, /\(\?:grade\|rating\|score\)\[:\\s\]\+/, f);
  }
});

test('"rating A-list cast" is not a grade; "rating: A-" still is', () => {
  assert.equal(ex('a rating A-list cast shines'), null);
  assert.equal(ex('Overall rating: A- for effort. More text here.').grade, 'A-');
});
