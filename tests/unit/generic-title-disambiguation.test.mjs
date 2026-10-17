/**
 * Unit tests for isGenericShowTitle + hasDisambiguator (scripts/lib/url-discovery.js).
 *
 * Generic one-word titles ("Sting", "Pride", "Mass") collide with unrelated content
 * in SERP. A bare-title substring match accepted wrong-show results — Sting 2026
 * (Sophie Swithinbank play, The Maria) pulled Sting-the-musician's "The Last Ship"
 * and "The Sting"/Harry Connick reviews, producing a fake live CriticScore (2026-06-21).
 * The acceptance loop now requires a disambiguator (venue / cast / creative surname /
 * opening year) for generic titles only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isGenericShowTitle, hasDisambiguator, canDisambiguateGenericTitle } = require('../../scripts/lib/url-discovery.js');

describe('isGenericShowTitle', () => {
  test('single-word titles are generic', () => {
    for (const t of ['Sting', 'Pride', 'Mass', 'Consumed', 'Maggots', 'Equus', 'Copenhagen']) {
      assert.strictEqual(isGenericShowTitle(t), true, t);
    }
  });
  test('leading article is stripped before counting', () => {
    assert.strictEqual(isGenericShowTitle('The Price'), true);
    assert.strictEqual(isGenericShowTitle('A Doll'), true);
  });
  test('punctuation does not block detection', () => {
    assert.strictEqual(isGenericShowTitle('CARE!'), true);
    assert.strictEqual(isGenericShowTitle('Sting?'), true);
  });
  test('multi-word titles are NOT generic (avoid over-tightening discovery)', () => {
    for (const t of ['War Horse', 'Inter Alia', 'A Life in Four Seasons', 'Glengarry Glen Ross', 'This Is Rambert']) {
      assert.strictEqual(isGenericShowTitle(t), false, t);
    }
  });
  test('empty / invalid input is not generic', () => {
    assert.strictEqual(isGenericShowTitle(''), false);
    assert.strictEqual(isGenericShowTitle(null), false);
    assert.strictEqual(isGenericShowTitle(undefined), false);
  });
});

describe('hasDisambiguator (Sting 2026 production)', () => {
  const sting = {
    year: '2026',
    venue: 'The Maria Theatre',
    cast: [{ name: 'Declan Bennett' }, { name: 'Jackie White' }],
    creativeNames: ['Sophie Swithinbank', 'Nancy Medina'],
    leadActor: 'Declan Bennett',
  };

  test('venue token (maria) corroborates', () => {
    assert.strictEqual(hasDisambiguator('review: sting at the maria', sting), true);
  });
  test('creative surname (swithinbank) corroborates', () => {
    assert.strictEqual(hasDisambiguator('sting by sophie swithinbank — review', sting), true);
  });
  test('cast surname (bennett) corroborates', () => {
    assert.strictEqual(hasDisambiguator('declan bennett stars in sting', sting), true);
  });
  test('year alone does NOT corroborate (dropped — defeated the gate)', () => {
    // A same-year wrong-show page must not pass on year alone.
    assert.strictEqual(hasDisambiguator('the last ship review sting musical 2026 tour', sting), false);
  });
  test('wrong-show content (The Last Ship 2014) has NO disambiguator', () => {
    assert.strictEqual(hasDisambiguator('the last ship review sting musical 2014 broadway', sting), false);
  });
  test('wrong-show content (Harry Connick The Sting, no year/venue/people) has none', () => {
    assert.strictEqual(hasDisambiguator('the sting harry connick paper mill playhouse', sting), false);
  });
  test('empty haystack -> false', () => {
    assert.strictEqual(hasDisambiguator('', sting), false);
  });
  test('common venue words (theatre/royal/the) do NOT count as disambiguator', () => {
    // "the last ship" at "some theatre" must not pass on the generic word 'theatre'
    assert.strictEqual(hasDisambiguator('the last ship review at the theatre', sting), false);
  });
});

describe('canDisambiguateGenericTitle — only gate when we can judge fairly', () => {
  test('show with cast can be gated', () => {
    assert.strictEqual(canDisambiguateGenericTitle({ cast: [{ name: 'A B' }], creativeNames: [] }), true);
  });
  test('show with creative names can be gated', () => {
    assert.strictEqual(canDisambiguateGenericTitle({ cast: [], creativeNames: ['A B'] }), true);
  });
  test('sparse show (no cast, no creative) is NOT gated — avoid under-collection', () => {
    // e.g. Mass @ Donmar with empty cast/creative: skip the gate rather than risk
    // rejecting a legit review whose snippet omits the venue.
    assert.strictEqual(canDisambiguateGenericTitle({ venue: 'Donmar Warehouse', cast: [], creativeNames: [] }), false);
  });
  test('missing arrays are safe (false, no crash)', () => {
    assert.strictEqual(canDisambiguateGenericTitle({}), false);
  });
});
