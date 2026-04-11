/**
 * Unit tests for pull-quote-guards.js
 *
 * Covers the reservation-rejection path that prevents extract-pull-quotes.js
 * from picking hedge-opener sentences as pull quotes on positive reviews —
 * the NYT "middle-paragraph caveat" bug.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isHedgeOpener,
  hasMidSentencePivot,
  shouldRejectAsReservation,
} = require('../../scripts/lib/pull-quote-guards.js');

describe('isHedgeOpener', () => {
  test('matches common hedge openers', () => {
    assert.strictEqual(isHedgeOpener('But the production struggles to find its heart.'), true);
    assert.strictEqual(isHedgeOpener('Yet the book never lives up to its premise.'), true);
    assert.strictEqual(isHedgeOpener('Still, the lead performance saves the evening.'), true);
    assert.strictEqual(isHedgeOpener('Though large, it is less a full-scale new work than a souvenir.'), true);
    assert.strictEqual(isHedgeOpener('Although the choreography dazzles, the story falters.'), true);
    assert.strictEqual(isHedgeOpener('However, the second act loses momentum.'), true);
    assert.strictEqual(isHedgeOpener('Despite the strong cast, the evening drags.'), true);
    assert.strictEqual(isHedgeOpener('While the sets are stunning, the plot is thin.'), true);
  });

  test('case-insensitive', () => {
    assert.strictEqual(isHedgeOpener('BUT this is really good.'), true);
    assert.strictEqual(isHedgeOpener('yet it works.'), true);
  });

  test('ignores leading quotes and whitespace', () => {
    assert.strictEqual(isHedgeOpener('"But still great."'), true);
    assert.strictEqual(isHedgeOpener('  \u201CYet it triumphs.\u201D'), true);
    assert.strictEqual(isHedgeOpener("'Still, the show dazzles.'"), true);
  });

  test('does not match hedge words mid-sentence', () => {
    assert.strictEqual(
      isHedgeOpener('This is a triumph, but one worth celebrating.'),
      false
    );
    assert.strictEqual(
      isHedgeOpener('The show is wonderful yet challenging.'),
      false
    );
  });

  test('does not match similar-looking words', () => {
    // "Butcher" starts with "but" but word boundary should not fire.
    assert.strictEqual(isHedgeOpener('Butcher is brilliant in the role.'), false);
    // "Yetiverse" — not a word, but guard against false positives on extensions.
    assert.strictEqual(isHedgeOpener('Yetiverse is a weird title, but the show works.'), false);
    // "Stillness" starts with "still" but word boundary should not fire.
    assert.strictEqual(isHedgeOpener('Stillness pervades every scene.'), false);
  });

  test('handles null / empty / non-string input', () => {
    assert.strictEqual(isHedgeOpener(null), false);
    assert.strictEqual(isHedgeOpener(undefined), false);
    assert.strictEqual(isHedgeOpener(''), false);
    assert.strictEqual(isHedgeOpener(42), false);
  });
});

describe('shouldRejectAsReservation', () => {
  test('rejects hedge opener on positive review (score >= 70)', () => {
    assert.strictEqual(
      shouldRejectAsReservation('But the pacing feels off.', 77),
      true,
      'score 77 + hedge → reject'
    );
    assert.strictEqual(
      shouldRejectAsReservation('Still, the show never lands its punches.', 85),
      true,
      'score 85 + hedge → reject'
    );
    assert.strictEqual(
      shouldRejectAsReservation('Yet I found myself unmoved.', 70),
      true,
      'score 70 (boundary) + hedge → reject'
    );
  });

  test('allows hedge opener on mixed review (40-69)', () => {
    // Hedge openers are often legitimate on mixed reviews.
    assert.strictEqual(
      shouldRejectAsReservation('Still, the show finds enough joy to justify the ticket.', 62),
      false
    );
  });

  test('allows hedge opener on negative review (< 40)', () => {
    // On a negative review, a hedge can be the critic's verdict ("Still, it never works").
    assert.strictEqual(
      shouldRejectAsReservation('Still, the evening never finds its footing.', 25),
      false
    );
  });

  test('allows non-hedge sentence regardless of score', () => {
    assert.strictEqual(
      shouldRejectAsReservation('A triumph of stagecraft that commands attention.', 95),
      false
    );
    assert.strictEqual(
      shouldRejectAsReservation('The show is a dull affair.', 20),
      false
    );
    assert.strictEqual(
      shouldRejectAsReservation('Recalling yet outstripping its predecessors, it soars.', 88),
      false,
      '"yet" mid-sentence is fine'
    );
  });

  test('passes when score is unknown', () => {
    assert.strictEqual(shouldRejectAsReservation('But this is really good.', null), false);
    assert.strictEqual(shouldRejectAsReservation('But this is really good.', undefined), false);
    assert.strictEqual(shouldRejectAsReservation('But this is really good.', NaN), false);
  });

  test('regression cases from real NYT data', () => {
    // giant-2026 Helen Shaw — score 77, hedge-opener pull quote was a reservation.
    assert.strictEqual(
      shouldRejectAsReservation(
        'But I found myself more engaged by the conversations I\u2019ve had since seeing Giant.',
        77
      ),
      true
    );
    // a-christmas-carol-2019 Jesse Isaenberg — score 72.
    assert.strictEqual(
      shouldRejectAsReservation(
        'Though Cerveris is given more story points to hit than psychological depths to plumb.',
        72
      ),
      true
    );
    // back-to-the-future-2023 Jesse Green — score 73.
    assert.strictEqual(
      shouldRejectAsReservation(
        'Though large, it\u2019s less a full-scale new work than a semi-operable souvenir.',
        73
      ),
      true
    );
    // giant-2026 Helen Shaw — actual live pull quote with mid-sentence "but" pivot.
    assert.strictEqual(
      shouldRejectAsReservation(
        'I found Lithgow\u2019s performance a fascinating study in monstrosity, but I found myself more engaged by the conversations I\u2019ve had since seeing \u201CGiant\u201D.',
        77
      ),
      true,
      'mid-sentence ", but" pivot on 77 review'
    );
  });
});

describe('hasMidSentencePivot', () => {
  test('detects ", but" mid-sentence pivots', () => {
    assert.strictEqual(
      hasMidSentencePivot('A stunning production, but the book is wafer-thin.'),
      true
    );
    assert.strictEqual(
      hasMidSentencePivot('Lithgow is magnetic, yet the evening drags.'),
      true
    );
    assert.strictEqual(
      hasMidSentencePivot('The cast delivers, though the writing wobbles.'),
      true
    );
  });

  test('does not fire on legitimate non-pivot prose', () => {
    // No comma before "but" — not a pivot.
    assert.strictEqual(
      hasMidSentencePivot('The production soars but never overreaches.'),
      false
    );
    // "and but" / "or but" — unusual, not a pivot.
    assert.strictEqual(
      hasMidSentencePivot('A hit.'),
      false
    );
  });
});
