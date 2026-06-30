/**
 * Unit tests for scripts/lib/roundup-digest.js — detect WestEndTheatre review-
 * roundup DIGESTS mis-stored as individual reviews. Precondition: WET url on a
 * non-WET outlet. MUST flag digests; MUST NOT flag a real critic's relayed
 * excerpt, and MUST NOT touch a legitimate review on its own domain.
 *
 * Run: node --test tests/unit/roundup-digest.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectRoundupDigest } = require('../../scripts/lib/roundup-digest.js');

const WET = 'https://www.westendtheatre.com/351724/news/reviews/the-price-reviews/';

describe('detectRoundupDigest', () => {
  test('flags digest text on a WET-misattributed file', () => {
    const r = detectRoundupDigest({ fullText: 'Reviews are in for The Price, and the verdict is...', criticName: 'Ghenet Pinderhughes Randall', url: WET, outletId: 'telegraph' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags publication-name-as-critic on a WET-misattributed file', () => {
    const r = detectRoundupDigest({ fullText: 'Passion at the Donmar — a strong revival.', criticName: 'Daily Telegraph', url: WET, outletId: 'daily-mail' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags a known WET roundup author on a WET-misattributed file', () => {
    const r = detectRoundupDigest({ fullText: '19 years after its first staging, War Horse returns.', criticName: 'West End Theatre', url: WET, outletId: 'timeout' });
    assert.equal(r?.isRoundup, true);
  });

  test('does NOT flag a real critic excerpt relayed via WET (Tim Bano / FT — the counted case)', () => {
    const r = detectRoundupDigest({ fullText: 'Nineties garage music and nods to Beyoncé put new flesh on the old bones of Wilde’s comedy.', criticName: 'Tim Bano', url: WET, outletId: 'financialtimes' });
    assert.equal(r, null);
  });

  test('does NOT flag a legit review on its OWN domain (precondition: must be a WET url)', () => {
    // FT bylines staff reviews as "Financial Times" on ft.com — legitimate.
    assert.equal(detectRoundupDigest({ fullText: 'A pointed, well-argued FT review.', criticName: 'Financial Times', url: 'https://www.ft.com/content/abc', outletId: 'financialtimes' }), null);
    // The Stage bylines some reviews as "The Stage" on thestage.co.uk — legitimate.
    assert.equal(detectRoundupDigest({ fullText: 'A real Stage review mentioning the critics have had their say.', criticName: 'The Stage', url: 'https://www.thestage.co.uk/reviews/x', outletId: 'thestage' }), null);
  });

  test('does NOT flag a WET page that IS the WestEndTheatre outlet itself', () => {
    assert.equal(detectRoundupDigest({ fullText: 'Reviews are in for X.', criticName: 'West End Theatre', url: WET, outletId: 'westendtheatre' }), null);
  });

  test('returns null on empty input', () => {
    assert.equal(detectRoundupDigest({}), null);
    assert.equal(detectRoundupDigest(null), null);
  });
});
