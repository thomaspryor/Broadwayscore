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
  isInternalNote,
  hasCopyrightChrome,
  isOffTopicExcerpt,
  isPromoTeaser,
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

describe('isInternalNote (Bug #11)', () => {
  test('rejects excerpts starting with [', () => {
    assert.strictEqual(isInternalNote('[INTERNAL: score needs review]'), true);
    assert.strictEqual(isInternalNote('[NOTE: check this]'), true);
    assert.strictEqual(isInternalNote('[TODO: fix excerpt]'), true);
    assert.strictEqual(isInternalNote('  [leading whitespace]'), true);
  });

  test('rejects excerpts containing [INTERNAL or [NOTE anywhere', () => {
    assert.strictEqual(isInternalNote('Great show. [INTERNAL: double-check score]'), true);
    assert.strictEqual(isInternalNote('Powerful performance [NOTE: needs update]'), true);
  });

  test('allows normal excerpts that happen to contain brackets', () => {
    // Show titles with brackets, or legitimate quotation
    assert.strictEqual(isInternalNote('A dazzling production (see Act 2).'), false);
    assert.strictEqual(isInternalNote('The cast is superb — especially the lead.'), false);
  });

  test('handles null / empty / non-string input', () => {
    assert.strictEqual(isInternalNote(null), false);
    assert.strictEqual(isInternalNote(undefined), false);
    assert.strictEqual(isInternalNote(''), false);
    assert.strictEqual(isInternalNote(42), false);
  });
});

describe('hasCopyrightChrome (Bug #14)', () => {
  test('rejects common copyright/subscribe patterns', () => {
    assert.strictEqual(hasCopyrightChrome('All Rights Reserved.'), true);
    assert.strictEqual(hasCopyrightChrome('Subscribe to our newsletter.'), true);
    assert.strictEqual(hasCopyrightChrome('© 2024 The New York Times.'), true);
    assert.strictEqual(hasCopyrightChrome('Read more at broadway.com'), true);
    assert.strictEqual(hasCopyrightChrome('Click here to read the full review.'), true);
    assert.strictEqual(hasCopyrightChrome('Sign up for our weekly digest.'), true);
    assert.strictEqual(hasCopyrightChrome('This newsletter covers Broadway.'), true);
  });

  test('is case-insensitive', () => {
    assert.strictEqual(hasCopyrightChrome('all rights reserved'), true);
    assert.strictEqual(hasCopyrightChrome('SUBSCRIBE TO our alerts'), true);
    assert.strictEqual(hasCopyrightChrome('READ MORE AT nytimes.com'), true);
  });

  test('allows clean review excerpts', () => {
    assert.strictEqual(
      hasCopyrightChrome('A bravura performance from a cast firing on all cylinders.'),
      false
    );
    assert.strictEqual(
      hasCopyrightChrome('The revival is better than its predecessor in every way.'),
      false
    );
  });

  test('handles null / empty / non-string input', () => {
    assert.strictEqual(hasCopyrightChrome(null), false);
    assert.strictEqual(hasCopyrightChrome(undefined), false);
    assert.strictEqual(hasCopyrightChrome(''), false);
  });
});

describe('isOffTopicExcerpt (Bug #13)', () => {
  test('passes excerpts with theater-domain words', () => {
    assert.strictEqual(
      isOffTopicExcerpt('A stunning performance from the entire cast.', 'hamilton-2015'),
      false
    );
    assert.strictEqual(
      isOffTopicExcerpt('The musical direction is exceptional.', 'hamilton-2015'),
      false
    );
    assert.strictEqual(
      isOffTopicExcerpt('This production of the play is riveting.', 'giant-2026'),
      false
    );
  });

  test('passes excerpts containing show title keywords', () => {
    assert.strictEqual(
      isOffTopicExcerpt('Hamilton delivers on every front.', 'hamilton-2015'),
      false,
      'showId keyword match'
    );
    assert.strictEqual(
      isOffTopicExcerpt('Giant looms large as a piece of history.', 'giant-2026'),
      false
    );
  });

  test('rejects excerpts with no theater words and no title match', () => {
    assert.strictEqual(
      isOffTopicExcerpt(
        'Mindfulness is the practice of bringing full attention to the present moment.',
        'hamilton-2015'
      ),
      true,
      'off-topic meditation excerpt'
    );
  });

  test('is loose — does not reject short excerpts that happen to lack title words but have theater words', () => {
    // "stage" is a theater-domain word
    assert.strictEqual(
      isOffTopicExcerpt('She takes the stage with confidence.', 'six-2021'),
      false
    );
  });

  test('handles null / empty / no showId', () => {
    assert.strictEqual(isOffTopicExcerpt(null, 'hamilton-2015'), false);
    assert.strictEqual(isOffTopicExcerpt('', 'hamilton-2015'), false);
    // Without showId, only theater-domain check runs
    assert.strictEqual(
      isOffTopicExcerpt('A wonderful performance.', null),
      false,
      'theater word present'
    );
    assert.strictEqual(
      isOffTopicExcerpt('Mindfulness is calming.', null),
      true,
      'no theater word, no showId'
    );
  });
});

describe('isPromoTeaser', () => {
  test('rejects NYTG/LondonTheatre SEO standfirsts (all 6 live instances, 2026-07-14)', () => {
    const live = [
      "Read our review of The Whoopi Monologues off Broadway, a reimagined version of Whoopi Goldberg's self-titled 1984 solo show now directed by Whitney White.",
      "Read our review of Jocelyn Bioh's Jaja's African Hair Braiding, now in performances at the Old Vic.",
      "Read our review of David Hare's play Teeth 'n' Smiles, now in performances at the Duke of York's Theatre.",
      "Read our review of Ryan Craig's play The Holy Rosenbergs, now in performances at the Menier Chocolate Factory.",
      "Read our review of The Roommate on Broadway, a comedy play written by Jen Silverman and starring Mia Farrow and Patti LuPone.",
      "Read our review of The Tempest, now in performances at the Sam Wanamaker Playhouse to 12 April.",
    ];
    for (const q of live) assert.strictEqual(isPromoTeaser(q), true, q.slice(0, 50));
  });

  test('rejects ticket CTAs and wrapped variants', () => {
    assert.strictEqual(isPromoTeaser('Buy tickets to the best show of the season.'), true);
    assert.strictEqual(isPromoTeaser('Tickets from $122 for this limited run.'), true);
    assert.strictEqual(isPromoTeaser('"Read the full review at our site."'), true);
    assert.strictEqual(isPromoTeaser('\u201dRead our review of the show.\u201d'), true, 'closing-quote wrap');
    assert.strictEqual(isPromoTeaser('\u2019Buy tickets today.'), true, 'closing-apostrophe wrap');
    assert.strictEqual(isPromoTeaser('Book your tickets now before it closes.'), true);
  });

  test('does NOT reject critic prose that mentions reviews or tickets mid-sentence', () => {
    assert.strictEqual(isPromoTeaser('This revival is worth every penny of the ticket price.'), false);
    assert.strictEqual(isPromoTeaser('Critics who read our city right will love this.'), false);
    assert.strictEqual(isPromoTeaser('Reading the play against its 1984 original reveals new depths.'), false);
    assert.strictEqual(isPromoTeaser('The ticket-buying public deserves better than this.'), false);
    assert.strictEqual(isPromoTeaser(''), false);
    assert.strictEqual(isPromoTeaser(null), false);
  });
});
