/**
 * titleTokens must fold diacritics before stripping non-alphanumerics.
 *
 * The bug: `titleTokens` lowercased, then ran `.replace(/[^a-z0-9 ]+/g, ' ')`.
 * That turns every accented letter into a SPACE, so one word shreds into
 * fragments that can never match an ASCII URL slug:
 *
 *   "Les Misérables"  ->  ["les", "mis", "rables"]     (should be ["les","miserables"])
 *   "La Bohème"       ->  ["boh"]                       (should be ["boheme"])
 *
 * urlMatchesShow requires n-1 of n tokens to appear as URL path segments, so
 * the phantom fragments made every real review URL unmatchable. On 2026-07-30
 * the gap audit reported "0 gaps" for `les-miserables-arena-concert-spectacular-
 * off-broadway-2026` while amNewYork and New York Theatre Guide were both live
 * and missing — a proven false negative, not a clean bill of health.
 *
 * Operas are the worst case: the fragment count collapses to 1-2 tokens, and
 * urlMatchesShow's `tokens.length <= 2` branch then demands a 100% match
 * against a fragment that cannot exist in any slug, so the census is totally
 * blind. 28 corpus shows are affected, including three upcoming operas.
 *
 * Run: node --test tests/unit/title-tokens-diacritics.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { titleTokens, urlMatchesShow } = require('../../scripts/audit-show-review-gap.js');

describe('titleTokens diacritic folding', () => {
  it('folds accents into their ASCII base letter, never into a space', () => {
    assert.deepStrictEqual(
      titleTokens('Les Misérables: The Arena Concert Spectacular'),
      ['les', 'miserables', 'arena', 'concert', 'spectacular']
    );
  });

  it('never emits the shredded fragments the bug produced', () => {
    const tokens = titleTokens('Les Misérables: The Arena Concert Spectacular');
    for (const phantom of ['mis', 'rables']) {
      assert.ok(
        !tokens.includes(phantom),
        `"${phantom}" is a diacritic-shred fragment and must not appear in ${JSON.stringify(tokens)}`
      );
    }
  });

  it('keeps single-word accented titles as one whole token', () => {
    // These collapse to 1-2 tokens, where urlMatchesShow demands a 100% match —
    // a shredded fragment there makes the census completely blind.
    assert.deepStrictEqual(titleTokens('La Bohème'), ['boheme']);
    assert.deepStrictEqual(titleTokens('Jenůfa'), ['jenufa']);
    assert.deepStrictEqual(titleTokens('Andrea Chénier'), ['andrea', 'chenier']);
    assert.deepStrictEqual(titleTokens('Così fan tutte'), ['cosi', 'fan', 'tutte']);
  });

  it('leaves unaccented titles unchanged', () => {
    assert.deepStrictEqual(titleTokens('Hamilton'), ['hamilton']);
    assert.deepStrictEqual(titleTokens('Death of a Salesman'), ['death', 'salesman']);
  });

  it('matches the real review URLs the census was rejecting', () => {
    // Live URLs from the BroadwayWorld roundup for this show. Before the fix
    // all of these rejected, which is why the audit reported zero gaps.
    const tokens = titleTokens('Les Misérables: The Arena Concert Spectacular');
    const shouldMatch = [
      'https://www.amny.com/entertainment/les-miserables-arena-concert-radio-city-review/',
      'https://1minutecritic.com/les-miserables-arena-concert-spectacular-review/',
      'https://nystagereview.com/2026/07/28/les-miserables-the-arena-concert-spectacular-you-will-hear/',
    ];
    for (const url of shouldMatch) {
      assert.ok(urlMatchesShow(url, tokens), `should match but rejected: ${url}`);
    }
  });

  it('still rejects a genuinely unrelated show URL', () => {
    // The fold must not loosen matching into false positives.
    const tokens = titleTokens('Les Misérables: The Arena Concert Spectacular');
    assert.strictEqual(
      urlMatchesShow('https://www.nytimes.com/2026/07/28/theater/hamilton-review.html', tokens),
      false
    );
  });
});
