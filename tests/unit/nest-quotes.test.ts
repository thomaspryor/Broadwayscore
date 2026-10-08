import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nestQuotes } from '../../src/lib/nest-quotes';

test('straight-quoted title inside a pull quote becomes single quotes', () => {
  assert.equal(
    nestQuotes('"Kramer/Fauci" is the most beautiful show I\u2019ve seen this year.'),
    '\u2018Kramer/Fauci\u2019 is the most beautiful show I\u2019ve seen this year.'
  );
});

test('curly-quoted phrase mid-sentence becomes single quotes', () => {
  assert.equal(
    nestQuotes('in the words of the moderator, \u201Can interesting and informative hour\u201D that works'),
    'in the words of the moderator, \u2018an interesting and informative hour\u2019 that works'
  );
});

test('quotes without nested quotation are unchanged', () => {
  const plain = 'Daniel Fish\u2019s brief, potent Kramer/Fauci makes the argument.';
  assert.equal(nestQuotes(plain), plain);
});

test('an unpaired quote mark is left alone', () => {
  assert.equal(nestQuotes('He said "it works'), 'He said "it works');
});
