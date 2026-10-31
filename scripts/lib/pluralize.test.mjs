import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pluralize, pluralNoun } = require('./pluralize.js');

test('pluralize: singular at exactly 1 (RECOUPED IN 1 WEEKS regression)', () => {
  assert.equal(pluralize(1, 'week'), '1 week');
});

test('pluralize: regular plural', () => {
  assert.equal(pluralize(18, 'week'), '18 weeks');
  assert.equal(pluralize(0, 'week'), '0 weeks');
});

test('pluralize: explicit irregular plural', () => {
  assert.equal(pluralize(2, 'party', 'parties'), '2 parties');
  assert.equal(pluralize(1, 'party', 'parties'), '1 party');
});

test('pluralNoun: noun only, count rendered by caller', () => {
  assert.equal(pluralNoun(1, 'review'), 'review');
  assert.equal(pluralNoun(-3, 'review'), 'reviews');
  assert.equal(pluralNoun(1, 'pt'), 'pt');
});
