/**
 * Unit tests for scripts/lib/roundup-digest.js — detect review-roundup DIGESTS
 * mis-stored as individual reviews (chiefly WestEndTheatre roundup pages under
 * telegraph/timeout/standard ids). MUST flag digests; MUST NOT flag a real
 * critic's relayed excerpt.
 *
 * Run: node --test tests/unit/roundup-digest.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectRoundupDigest } = require('../../scripts/lib/roundup-digest.js');

describe('detectRoundupDigest', () => {
  test('flags digest text ("Reviews are in for X")', () => {
    const r = detectRoundupDigest({ fullText: 'Reviews are in for The Price, playing a limited run at the Marylebone Theatre and the verdict is...', criticName: 'Ghenet Pinderhughes Randall', url: 'https://www.westendtheatre.com/351724/news/reviews/the-price-reviews/' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags "unanimous praise from the critics"', () => {
    const r = detectRoundupDigest({ fullText: 'Toby Stephens and Noah Valentine earn unanimous praise from the critics', criticName: 'Julianna Barnaby', url: 'https://www.westendtheatre.com/x/news/reviews/equus-reviews/' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags criticName that is a publication name', () => {
    const r = detectRoundupDigest({ fullText: 'Passion at the Donmar — a strong revival of the Sondheim.', criticName: 'Daily Telegraph', url: 'https://www.westendtheatre.com/x/passion/' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags a known WET roundup author on a WET url', () => {
    const r = detectRoundupDigest({ fullText: '19 years after its first staging, War Horse returns to the National.', criticName: 'West End Theatre', url: 'https://www.westendtheatre.com/x/war-horse-reviews/' });
    assert.equal(r?.isRoundup, true);
  });

  test('does NOT flag a real critic excerpt relayed via WET (the counted Tim Bano case)', () => {
    const r = detectRoundupDigest({ fullText: 'Nineties garage music and nods to Beyoncé put new flesh on the old bones of Wilde’s comedy.', criticName: 'Tim Bano', url: 'https://www.westendtheatre.com/x/an-ideal-husband-reviews/' });
    assert.equal(r, null);
  });

  test('does NOT flag a WET-author name when NOT on a WET url (safety)', () => {
    const r = detectRoundupDigest({ fullText: 'A real review of the show.', criticName: 'Julianna Barnaby', url: 'https://www.thetimes.co.uk/article/real-review' });
    assert.equal(r, null);
  });

  test('returns null on empty / ordinary review', () => {
    assert.equal(detectRoundupDigest({ fullText: 'A glowing, specific review of the production.', criticName: 'Matt Wolf', url: 'https://nytimes.com/x' }), null);
    assert.equal(detectRoundupDigest({}), null);
    assert.equal(detectRoundupDigest(null), null);
  });
});
