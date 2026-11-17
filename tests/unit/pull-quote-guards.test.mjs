// structural — asserts pure guard-function
// behavior against hardcoded fixture strings; never reads data/reviews.json
// at runtime (a header comment below documents that the fixture strings
// were originally copied from reviews.json, which trips the audit's
// textual pattern match, but no file I/O happens in this test file).
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
  isInServiceSection,
  isBadCandidateLength,
  MIN_QUOTE_LENGTH,
  MAX_QUOTE_LENGTH,
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

// ---------------------------------------------------------------------------
// 2026-08-01 guards — owner report: bad + missing pull quotes on new Broadway
// and West End shows. Every fixture below is REAL text that shipped to
// production, copied from data/reviews.json and the matching review-texts file.
// ---------------------------------------------------------------------------

const {
  hasListingChrome,
  stripListingPrelude,
  isTagCloudExcerpt,
  isMidWordTruncation,
  pickExcerptCandidate,
  EXCERPT_SOURCE_RANK,
} = require('../../scripts/lib/pull-quote-guards.js');

// tao-of-glass-west-end-2026 / british-theatre (the owner's screenshot)
const BTG_PRELUDE =
  'Philip Glass and Phelim McDermott Factory International, Improbable and Nica Burns ' +
  '@sohoplace theatre 24 July–12 September 2026 Listing details and ticket info... ' +
  'Tao of Glass finally makes it to London after opening at the Manchester International ' +
  'Festival in 2019 and subsequently touring globally. It is worth the wait. Phelim ' +
  'McDermott of Improbable theatre is well known for his imagination and creativity, but ' +
  'do we know of his decades-long passion for Philip Glass?';

// a-midsummer-nights-dream-west-end-2026 / thereviewshub — page tag list
const REVIEWS_HUB_TAGS =
  'Funny but unmagical A Midsummer Night’s Dream Atri Banerjee Issam Al Ghussain Jenny ' +
  'Rainford London Mary Malone Nadeem Islam Naomi Dawson Olivier Huband Regent’s Park ' +
  'Open Air Theatre Review Terique Jarrett Theatre Tomás Palmer William Shakespeare';

// teeth-n-smiles-west-end-2026 / standard — llmPullQuote vs its own keyPhrase
const STANDARD_TRUNCATED =
  'Today, it looks coarse and lumpen in Daniel Raggett’s unmodulated production, with ' +
  'Phil Daniels one of the few sa';
const STANDARD_COMPLETE =
  "Today, it looks coarse and lumpen in Daniel Raggett's unmodulated production, with " +
  'Phil Daniels one of the few saving graces as the casually exploitative manager Saraffian.';

// Legitimate quotes that must survive every new guard. The short ones are The
// Stage / Times headline standfirsts, which carry no terminal punctuation.
const GOOD_QUOTES = [
  'Full-blooded production of an undernourished play',
  'Rollicking mystery with an erratic Holmes',
  'Spirited feel-good musical relates a bittersweet true story of 1980s political activism',
  'Lyrical, sometimes surreal and charged equally with rage and joy, this relentlessly imaginative verse-drama',
  'It feels close to miraculous that a piece this experimental, this gentle and this patient can exist on a West End stage.',
  'Fortunately, for the most part, it also happens to be bloody marvellous.',
  // Prose naming many people — must not read as a tag cloud
  'Nicole Scherzinger, Tom Francis and Grace Hodgett Young are the reason to see Jamie Lloyd’s Sunset Boulevard.',
  // Prose mentioning months — must not read as listing chrome
  'When the show opened in March, nobody expected it to run through September.',
  // Corpus false positives from the first tag-cloud threshold pass (2026-08-01):
  // title- and name-heavy quotes with no sentence punctuation.
  'B+ "Tom Hiddleston, Charlie Cox, and Zawe Ashton command a smart, stripped down \'Betrayal\'"',
  "The Royal Shakespeare Company's My Neighbour Totoro is actual magic",
];

describe('hasListingChrome', () => {
  test('flags the British Theatre Guide listing block', () => {
    assert.strictEqual(hasListingChrome(BTG_PRELUDE), true);
  });
  test('flags a bare venue + run-dates range', () => {
    assert.strictEqual(hasListingChrome('At @sohoplace theatre 24 July–12 September 2026'), true);
  });
  test('leaves real critic prose alone', () => {
    for (const q of GOOD_QUOTES) {
      assert.strictEqual(hasListingChrome(q), false, `false positive on: ${q.slice(0, 60)}`);
    }
  });
});

describe('stripListingPrelude', () => {
  test('starts the text at the review body', () => {
    const out = stripListingPrelude(BTG_PRELUDE);
    assert.ok(out.startsWith('Tao of Glass finally makes it to London'), `got: ${out.slice(0, 80)}`);
    assert.strictEqual(hasListingChrome(out), false);
  });
  test('is a no-op with no boilerplate terminator', () => {
    const body = GOOD_QUOTES[4].repeat(3);
    assert.strictEqual(stripListingPrelude(body), body);
  });
  test('bails rather than reducing the text to a husk', () => {
    const husk = 'Some Venue 1 May–2 June 2026 Listing details and ticket info... Short tail.';
    assert.strictEqual(stripListingPrelude(husk), husk);
  });
  test('ignores a terminator buried deep in the body', () => {
    const deep = 'A'.repeat(600) + ' Listing details and ticket info... ' + 'B'.repeat(200);
    assert.strictEqual(stripListingPrelude(deep), deep);
  });
});

describe('isTagCloudExcerpt', () => {
  test('flags the Reviews Hub tag list', () => {
    assert.strictEqual(isTagCloudExcerpt(REVIEWS_HUB_TAGS), true);
  });
  test('leaves headlines and prose alone', () => {
    for (const q of GOOD_QUOTES) {
      assert.strictEqual(isTagCloudExcerpt(q), false, `false positive on: ${q.slice(0, 60)}`);
    }
  });
});

describe('isMidWordTruncation', () => {
  test('catches the Evening Standard cut against its own keyPhrase', () => {
    assert.strictEqual(isMidWordTruncation(STANDARD_TRUNCATED, [STANDARD_COMPLETE]), true);
  });
  test('clears the complete sentence itself', () => {
    assert.strictEqual(isMidWordTruncation(STANDARD_COMPLETE, [STANDARD_COMPLETE]), false);
  });
  test('clears a quote ending at a word boundary', () => {
    const src = 'The show is a delight. It runs three hours and never sags.';
    assert.strictEqual(isMidWordTruncation('The show is a delight. It runs three hours', [src]), false);
  });
  test('ignores a deliberate trailing ellipsis', () => {
    const src = 'A dazzling, ultimately moving show that never stops surprising you.';
    assert.strictEqual(isMidWordTruncation('A dazzling, ultimately moving show that never sto...', [src]), false);
  });
  test('needs a source — no evidence, no verdict', () => {
    assert.strictEqual(isMidWordTruncation(STANDARD_TRUNCATED, []), false);
  });
});

describe('pickExcerptCandidate', () => {
  test('returns an accepted curated candidate as-is', () => {
    assert.strictEqual(pickExcerptCandidate({
      accepted: { rank: EXCERPT_SOURCE_RANK.llmPullQuote, excerpt: 'good quote' },
      deferred: [{ rank: EXCERPT_SOURCE_RANK.keyPhrase, excerpt: 'hedged quote' }],
    }), 'good quote');
  });
  test('prefers a deferred curated quote over a raw fullText slice', () => {
    // Body Count / Theater Scene: a hedged llmPullQuote lost to a page scrape.
    assert.strictEqual(pickExcerptCandidate({
      accepted: { rank: EXCERPT_SOURCE_RANK.fullText, excerpt: 'raw page scrape' },
      deferred: [{ rank: EXCERPT_SOURCE_RANK.llmPullQuote, excerpt: 'hedged but real critic quote' }],
    }), 'hedged but real critic quote');
  });
  test('keeps the fullText slice when nothing was deferred', () => {
    assert.strictEqual(pickExcerptCandidate({
      accepted: { rank: EXCERPT_SOURCE_RANK.fullText, excerpt: 'raw page scrape' },
      deferred: [],
    }), 'raw page scrape');
  });
  test('returns the best deferred candidate when nothing was accepted', () => {
    // Les Misérables Arena / Cititour: every candidate soft-rejected → no quote.
    assert.strictEqual(pickExcerptCandidate({
      accepted: null,
      deferred: [
        { rank: EXCERPT_SOURCE_RANK.keyPhrase, excerpt: 'second best' },
        { rank: EXCERPT_SOURCE_RANK.llmPullQuote, excerpt: 'best available' },
      ],
    }), 'best available');
  });
  test('returns null when there is genuinely nothing', () => {
    assert.strictEqual(pickExcerptCandidate({ accepted: null, deferred: [] }), null);
    assert.strictEqual(pickExcerptCandidate({}), null);
  });
});

// ---------------------------------------------------------------------------
// Fixes from the 2026-08-01 Codex adversarial review.
// ---------------------------------------------------------------------------

describe('stripListingPrelude — prelude must itself look like a listing', () => {
  test('leaves critic prose that happens to use the boilerplate phrase', () => {
    // Codex scenario: the phrase appears inside a real opening sentence.
    const prose =
      "The programme's listing details and ticket info are more lucid than the " +
      'production itself, which spends three hours mistaking volume for feeling ' +
      'and never once trusts its audience to sit with a silence.';
    assert.strictEqual(stripListingPrelude(prose), prose);
  });
  test('still strips when run dates precede the terminator', () => {
    const out = stripListingPrelude(BTG_PRELUDE);
    assert.ok(out.startsWith('Tao of Glass finally makes it to London'));
  });
  test('still strips a punctuation-free credits run', () => {
    const credits =
      'Some Producer and Another Producer @sohoplace theatre Listing details and ticket info... ' +
      'The evening opens on a bare stage and never really recovers from the emptiness it starts ' +
      'with, which is a shame given how much talent is standing on it.';
    assert.ok(stripListingPrelude(credits).startsWith('The evening opens'));
  });
});

describe('pickExcerptCandidate — fragments must not beat a clean body sentence', () => {
  test('a lowercase fragment loses to an accepted fullText slice', () => {
    // Codex scenario: "and the score is sublime." reads broken on the card.
    assert.strictEqual(pickExcerptCandidate({
      accepted: { rank: EXCERPT_SOURCE_RANK.fullText, excerpt: 'A clean evaluative body sentence.' },
      deferred: [{ rank: EXCERPT_SOURCE_RANK.keyPhrase, excerpt: 'and the score is sublime.', reason: 'lowercase-fragment' }],
    }), 'A clean evaluative body sentence.');
  });
  test('a hedge deferral still beats an accepted fullText slice', () => {
    assert.strictEqual(pickExcerptCandidate({
      accepted: { rank: EXCERPT_SOURCE_RANK.fullText, excerpt: 'Raw page scrape.' },
      deferred: [{ rank: EXCERPT_SOURCE_RANK.llmPullQuote, excerpt: 'But it is undeniably electric.', reason: 'hedge' }],
    }), 'But it is undeniably electric.');
  });
  test('a lowercase fragment still wins when nothing was accepted', () => {
    assert.strictEqual(pickExcerptCandidate({
      accepted: null,
      deferred: [{ rank: EXCERPT_SOURCE_RANK.keyPhrase, excerpt: 'and the score is sublime.', reason: 'lowercase-fragment' }],
    }), 'and the score is sublime.');
  });
});

describe('isMidWordTruncation — normalized-source cache', () => {
  test('repeated calls on the same array agree with the uncached result', () => {
    const sources = [STANDARD_COMPLETE, 'Some other unrelated source text here.'];
    assert.strictEqual(isMidWordTruncation(STANDARD_TRUNCATED, sources), true);
    // Second call hits the cache — must not change the verdict.
    assert.strictEqual(isMidWordTruncation(STANDARD_TRUNCATED, sources), true);
    assert.strictEqual(isMidWordTruncation(STANDARD_COMPLETE, sources), false);
  });
  test('cache key is non-enumerable (array still serializes normally)', () => {
    const sources = [STANDARD_COMPLETE];
    isMidWordTruncation(STANDARD_TRUNCATED, sources);
    assert.strictEqual(sources.length, 1);
    assert.strictEqual(JSON.parse(JSON.stringify(sources)).length, 1);
  });
  test('tolerates a frozen sources array', () => {
    const frozen = Object.freeze([STANDARD_COMPLETE]);
    assert.strictEqual(isMidWordTruncation(STANDARD_TRUNCATED, frozen), true);
  });
});

describe('isBadCandidateLength', () => {
  test('rejects a real, on-topic, but too-short candidate', () => {
    // The exact string that shipped the Les Mis Arena Concert / Cititour bug
    // (em-20260801-000455): vivid, verbatim in the source text, but 25 chars —
    // the LLM's only viable pick gave up instead of retrying for a longer one.
    assert.strictEqual(isBadCandidateLength("Yes, they're spectacular!"), true);
  });
  test('accepts the real replacement quote extract-pull-quotes.js picked on retry', () => {
    assert.strictEqual(
      isBadCandidateLength('Finally, the ensemble numbers, most notably "One Day More" and "Can You Hear the People Sing" (led by the dashing Christian Mark Gibbs as revolutionary leader Enjolras) fill the heart, fill the ears, and fill the Hall.'),
      false
    );
  });
  test('boundary: exactly MIN_QUOTE_LENGTH chars is accepted, one under is not', () => {
    assert.strictEqual(isBadCandidateLength('x'.repeat(MIN_QUOTE_LENGTH)), false);
    assert.strictEqual(isBadCandidateLength('x'.repeat(MIN_QUOTE_LENGTH - 1)), true);
  });
  test('boundary: exactly MAX_QUOTE_LENGTH chars is accepted, one over is not', () => {
    assert.strictEqual(isBadCandidateLength('x'.repeat(MAX_QUOTE_LENGTH)), false);
    assert.strictEqual(isBadCandidateLength('x'.repeat(MAX_QUOTE_LENGTH + 1)), true);
  });
  test('empty/null-ish input is not flagged as a length problem (caller rejects it earlier)', () => {
    assert.strictEqual(isBadCandidateLength(''), false);
    assert.strictEqual(isBadCandidateLength(null), false);
  });
});

describe('isInServiceSection (BRO-4973)', () => {
  const body = 'Haddad’s play is intimate and engaging. As it traces parallel lives, Good Time Charlie is a flawed but heartfelt family love letter. '
    + 'What audiences are saying about Good Time Charlie Theatregoers expressed mixed reactions. '
    + 'Who should see Good Time Charlie Fans of Haddad’s earlier work will be keen. The family play is a staple of American theatre. Audiences who appreciate the genre will want to see it. '
    + 'Theatregoers who appreciate a well-tuned ensemble will enjoy seeing each actor get moments in the spotlight. '
    + 'Learn more about Good Time Charlie off Broadway. Good Time Charlie is a flawed but heartfelt family love letter. Tickets on sale now.';

  test('flags the GTC NYTG boilerplate sentence', () => {
    assert.strictEqual(isInServiceSection('The family play is a staple of American theatre.', body), true);
  });
  test('does not flag the critic verdict line', () => {
    assert.strictEqual(isInServiceSection('Good Time Charlie is a flawed but heartfelt family love letter.', body), false);
  });
  test('quote not in text or empty input is not flagged', () => {
    assert.strictEqual(isInServiceSection('absent sentence here', body), false);
    assert.strictEqual(isInServiceSection('', body), false);
    assert.strictEqual(isInServiceSection('x', null), false);
  });
});

// BRO-751: "yet again" is emphasis, not a reservation pivot.
test('", yet again in triumph" on a rave is not rejected as a reservation', () => {
  assert.equal(shouldRejectAsReservation('Now at the Winter Garden Theater, "Death of a Salesman" has returned to Broadway, yet again in triumph.', 92), false);
  assert.equal(shouldRejectAsReservation('The set is impressive, but nothing could save this salesman from death.', 92), true);
  assert.equal(shouldRejectAsReservation('The cast is lovely, yet the evening never takes flight.', 85), true);
});

// BRO-5796: scraped fullText glues a headline to the next line. The real
// 1984-2017 Bloomberg and Malory Towers Time Out quotes were flagged as cut.
test('a headline glued to a capitalized next word is not a mid-word cut', () => {
  const q = 'Broadway’s 1984 Is an Electrifying Fable With a Message for the Resistance';
  assert.strictEqual(isMidWordTruncation(q, [`${q}By Jason ZinomanThe show opens`]), false);
  const cut = 'The play has lost its essential velocity in the move from Lincoln Cent';
  assert.strictEqual(isMidWordTruncation(cut, [`${cut}er Theater, where`]), true);
  const lowerNext = 'Meteor Shower may be a cloudburst of laugh lines lasting only about 80 minutes, but it';
  assert.strictEqual(isMidWordTruncation(lowerNext, [`${lowerNext}s non-sequiturs`]), true);
});

test('a name cut after a short prefix ("Mc", "Lu") is still a mid-word cut', () => {
  const q = 'The evening belongs entirely to the great and incomparable Audra Mc';
  assert.strictEqual(isMidWordTruncation(q, [`${q}Donald, who sings`]), true);
  const q2 = 'Nobody else on Broadway sings the role quite the way it is sung by Patti Lu';
  assert.strictEqual(isMidWordTruncation(q2, [`${q2}Pone tonight`]), true);
});

// BRO-6631: sentences that lean on the one before them (A Few Good Men, 2026-10-29).
describe('isContextDependentQuote', () => {
  const { isContextDependentQuote, endsWithSourceEllipsis, snapToSourceSpan: snap } = require('../../scripts/lib/pull-quote-guards.js');
  test('flags the shipped A Few Good Men quotes the owner saw', () => {
    for (const q of [
      'Despite this elaborate choreography, Arden’s production works as theater only intermittently.',
      'If only the rest of the production felt as up-to-date.',
      'Truth be told, though, the main struggle here has to be within Kaffee and that really is not visible at all.',
      'That makes the clumsiness in some of his writing regrettable.',
      'This is hardly a problem, just an oddity in what is ultimately another Chekhov banger.',
      'Yet despite this, and the brilliant work of a strong ensemble, the play still feels strangely remote.',
      'Even his skills can’t salvage this show.',
      'Fortunately, the verdict rests with the former.',
      '“If only these actors could dedicate themselves to better material.',
    ]) assert.strictEqual(isContextDependentQuote(q), true, q);
  });
  test('leaves standalone verdicts alone', () => {
    for (const q of [
      'It’s a starchy, listless production that never finds a proper sense of scale.',
      'This is pitch-perfect theatre-making that manages to be utterly clear and technically brilliant.',
      'This is not to be missed.',
      'This makes for a highly watchable drama.',
      'Despite this production’s flaws, the cast is superb.',
      'For all those who love this great Broadway musical, the present revival is not to be missed.',
      'The result is a play that feels vital and gripping.',
      'Even so, 1776 succeeds where it counts.',
      'Her performance is a revelation.',
      'The former Harry Potter plays the title role and casts a spell.',
      'That said, Dad Don’t Read This is highly entertaining.',
    ]) assert.strictEqual(isContextDependentQuote(q), false, q);
  });
  test('endsWithSourceEllipsis spots aggregator-clipped blurbs', () => {
    assert.strictEqual(endsWithSourceEllipsis('But Sorkin’s script evens out, and ...'), true);
    assert.strictEqual(endsWithSourceEllipsis('you’d be foolish not to grab a ticket ‒…”'), true);
    assert.strictEqual(endsWithSourceEllipsis('A complete sentence.'), false);
  });
  test('snapToSourceSpan does not end a sentence at "Oct." or "Lt."', () => {
    const body = 'Intro line here. It’s a tough act to follow, but under Arden’s direction the show is as compelling as ever in a revival that opened Oct. 29 at the Beaumont. Lt. Kaffee is sharp. Next.';
    const s = snap('under Arden’s direction the show is as compelling as ever in a revival.', body);
    assert.strictEqual(s, 'It’s a tough act to follow, but under Arden’s direction the show is as compelling as ever in a revival that opened Oct. 29 at the Beaumont.');
  });
  test('a back-reference that names the show is standalone', () => {
    assert.strictEqual(isContextDependentQuote('That makes A Strange Loop the best new musical of the Broadway season.', { showTitle: 'A Strange Loop' }), false);
    assert.strictEqual(isContextDependentQuote('That is emphatically not the case with Skylight, thrillingly revived.', { showTitle: 'Skylight' }), false);
    assert.strictEqual(isContextDependentQuote('Despite this elaborate choreography, Arden’s production works only intermittently.', { showTitle: 'A Few Good Men' }), true);
  });
  test('review fixes: FPs, possessive and common-word titles, real sentence-end "Dec."', () => {
    assert.strictEqual(isContextDependentQuote('This is true artistry, a revival for the ages.'), false);
    assert.strictEqual(isContextDependentQuote('This is exactly the kind of musical Broadway needs.'), false);
    assert.strictEqual(isContextDependentQuote('That is Company’s finest hour.', { showTitle: 'Company' }), false);
    assert.strictEqual(isContextDependentQuote('That is why the company shines.', { showTitle: 'Company' }), true);
    const s = snap('The cast is great and Sutton Foster sings like a dream.', 'Intro here. The run ends in Dec. The cast is great and Sutton Foster sings like a dream. Bye.');
    assert.strictEqual(s, 'The cast is great and Sutton Foster sings like a dream.');
  });
  test('a stored context-dependent quote is re-extracted once, then kept', () => {
    const { hasUsableLlmQuote } = require('../../scripts/lib/pull-quote-guards.js');
    const d = { llmPullQuote: 'If only the rest of the production felt as up-to-date.', fullText: 'x If only the rest of the production felt as up-to-date. y' };
    assert.strictEqual(hasUsableLlmQuote(d), false);
    assert.strictEqual(hasUsableLlmQuote({ ...d, llmPullQuoteContextCheckedAt: '2026-10-30T00:00:00Z' }), true);
  });
  test('a clipped blurb beats a raw slice but loses to a paraphrased complete verdict', () => {
    const raw = { rank: 99, excerpt: 'Raw body slice.' };
    const blurb = { rank: 4, excerpt: 'One. Two, and ...', reason: 'source-truncated' };
    const para = { rank: 0, excerpt: 'A complete verdict.', reason: 'non-contiguous' };
    assert.strictEqual(pickExcerptCandidate({ accepted: raw, deferred: [blurb] }), blurb.excerpt);
    assert.strictEqual(pickExcerptCandidate({ accepted: null, deferred: [blurb, para] }), para.excerpt);
  });
  test('isClippedAggregatorBlurb: multi-sentence clipped blurbs only', () => {
    const { isClippedAggregatorBlurb } = require('../../scripts/lib/pull-quote-guards.js');
    assert.strictEqual(isClippedAggregatorBlurb('In some ways, it is a classic tale. This particular story gets off to a slow start. But Sorkin’s script evens out, and ...'), true);
    assert.strictEqual(isClippedAggregatorBlurb('This is strong stuff, and the cast is up to the task...'), false);
    assert.strictEqual(isClippedAggregatorBlurb('A complete two-sentence quote. It ends properly.'), false);
  });
});

// BRO-7598: WSJ on Downstate (2026-11-15) shipped a verbatim quote cut from
// inside an "as" clause. The source text, not the quote, shows the cut.
describe('startsMidClause / hasUsableLlmQuote', () => {
  const { startsMidClause, hasUsableLlmQuote } = require('../../scripts/lib/pull-quote-guards.js');
  const wsj = 'Yes, these men are monsters. A playwright’s responsibility isn’t to either forgive or condemn, but to render life in all its complexity, to present us with a vision of humanity that is truthful, as Mr. Norris so superbly does in this troubling but terrific play. Booth Theatre, 222 W. 45th St.';
  const fragment = 'Mr. Norris so superbly does in this troubling but terrific play.';

  test('flags a quote that starts right after "as" in the same sentence, and re-queues the stored one', () => {
    assert.strictEqual(startsMidClause(fragment, wsj), true);
    assert.strictEqual(hasUsableLlmQuote({ llmPullQuote: fragment, fullText: wsj, showTitle: 'Downstate' }), false);
    // Once a re-extraction has judged it, it is kept (no endless re-queue).
    assert.strictEqual(hasUsableLlmQuote({ llmPullQuote: fragment, fullText: wsj, llmPullQuoteContextCheckedAt: '2026-11-16T00:00:00Z' }), true);
  });

  test('the whole sentence, and the quote without its source, are not flagged', () => {
    const whole = 'A playwright’s responsibility isn’t to either forgive or condemn, but to render life in all its complexity, to present us with a vision of humanity that is truthful, as Mr. Norris so superbly does in this troubling but terrific play.';
    assert.strictEqual(startsMidClause(whole, wsj), false);
    assert.strictEqual(hasUsableLlmQuote({ llmPullQuote: whole, fullText: wsj }), true);
    assert.strictEqual(startsMidClause(fragment, ''), false);
  });

  test('a paragraph opening with "As", and a quote mark after the lead word, are still caught', () => {
    const t1 = 'Intro paragraph ends here.\nAs Mr. Norris so superbly does in this troubling play, he wins us over.';
    assert.strictEqual(startsMidClause('Mr. Norris so superbly does in this troubling play, he wins us over.', t1), true);
    const t2 = 'It is very good, as “Mr. Norris so superbly does in this troubling play” proves to us all.';
    assert.strictEqual(startsMidClause('Mr. Norris so superbly does in this troubling play', t2), true);
  });

  test('a dropped leading clause after a comma, "that", or a paragraph break stays usable', () => {
    const t1 = 'Despite this elaborate choreography, Arden’s production works as theater only intermittently. More text follows here.';
    assert.strictEqual(startsMidClause('Arden’s production works as theater only intermittently.', t1), false);
    const t2 = 'I would say that the cast of this revival is the finest on Broadway right now. Go.';
    assert.strictEqual(startsMidClause('the cast of this revival is the finest on Broadway right now.', t2), false);
    const t3 = 'It plays as\nThe cast of this revival is the finest on Broadway right now.';
    assert.strictEqual(startsMidClause('The cast of this revival is the finest on Broadway right now.', t3), false);
  });

  test('a leading ellipsis is an honest elision; a repeated passage is not judged', () => {
    assert.strictEqual(startsMidClause('...Mr. Norris so superbly does in this troubling but terrific play.', wsj), false);
    const twice = 'Good, as Mr. Norris so superbly does in this play. Later: Mr. Norris so superbly does in this play.';
    assert.strictEqual(startsMidClause('Mr. Norris so superbly does in this play.', twice), false);
  });
});

describe('expandToSentenceStart', () => {
  const { expandToSentenceStart } = require('../../scripts/lib/pull-quote-guards.js');
  const wsj = 'Yes, these men are monsters. A playwright’s responsibility isn’t to either forgive or condemn, but to render life in all its complexity, to present us with a vision of humanity that is truthful, as Mr. Norris so superbly does in this troubling but terrific play. Booth Theatre, 222 W. 45th St.';
  test('a mid-clause fragment becomes the critic’s whole sentence', () => {
    assert.strictEqual(expandToSentenceStart('Mr. Norris so superbly does in this troubling but terrific play.', wsj),
      'A playwright’s responsibility isn’t to either forgive or condemn, but to render life in all its complexity, to present us with a vision of humanity that is truthful, as Mr. Norris so superbly does in this troubling but terrific play.');
  });
  test('no expansion when the quote stops before the sentence ends, the sentence is too long, or nothing is mid-clause', () => {
    assert.strictEqual(expandToSentenceStart('Mr. Norris so superbly does in this troubling', wsj), null);
    assert.strictEqual(expandToSentenceStart('Mr. Norris so superbly does in this troubling but terrific play.', wsj, { maxLen: 100 }), null);
    assert.strictEqual(expandToSentenceStart('Yes, these men are monsters.', wsj), null);
  });
});

// BRO-7598: "not X, but Y" is a correction, not a reservation pivot.
describe('hasMidSentencePivot: corrective "not X, but Y"', () => {
  const wsj = 'A playwright’s responsibility isn’t to either forgive or condemn, but to render life in all its complexity, to present us with a vision of humanity that is truthful, as Mr. Norris so superbly does in this troubling but terrific play.';
  test('WSJ Downstate verdict sentence is not a reservation on a 93', () => {
    assert.equal(hasMidSentencePivot(wsj), false);
    assert.equal(shouldRejectAsReservation(wsj, 93), false);
  });
  test('"not only ..., but also" and "not X, but rather Y" are corrections', () => {
    assert.equal(hasMidSentencePivot('This production is not only packed with technical thrills, but also optimism and heart.'), false);
    assert.equal(hasMidSentencePivot("It doesn't try to reinvent the wheel, but rather polishes it to a lustrous sheen."), false);
  });
  test('a new subject after "but" is still a pivot', () => {
    assert.equal(hasMidSentencePivot('It isn’t perfect, but it is fun.'), true);
    assert.equal(hasMidSentencePivot('Not a masterpiece, but a solid evening.'), true);
  });
  test('concessions after "but to" stay pivots', () => {
    assert.equal(hasMidSentencePivot('It never quite lands, but to its credit it tries.'), true);
    assert.equal(hasMidSentencePivot('Humility is not a requirement for the role, but to this critic there is an undertone.'), true);
    assert.equal(hasMidSentencePivot('I never saw the revival, but to judge by the photos it was dull.'), true);
  });
  test('no negation: "but also" still counts as a pivot', () => {
    assert.equal(hasMidSentencePivot('Feeling fresh, but also a little dated.'), true);
  });
  test('a later real pivot still trips after an earlier corrective one', () => {
    assert.equal(hasMidSentencePivot('It is not only funny, but also moving, but the book sags.'), true);
  });
});

// BRO-7598 ship-check: per-but correction check and single-sentence expansion.
describe('BRO-7598 review follow-ups', () => {
  const { expandToSentenceStart } = require('../../scripts/lib/pull-quote-guards.js');
  test('a real pivot cannot borrow a later correction', () => {
    assert.equal(hasMidSentencePivot('Overlong, but not dull, but also thrilling.'), true);
  });
  test('concessions and "but also not" stay pivots', () => {
    assert.equal(hasMidSentencePivot('It isn’t flawless, but to our delight it soars.'), true);
    assert.equal(hasMidSentencePivot('It isn’t perfect, but to the cast’s credit it soars.'), true);
    assert.equal(hasMidSentencePivot('Not a masterpiece, but to say so misses the point.'), true);
    assert.equal(hasMidSentencePivot('It is not perfect, but also not bad.'), true);
  });
  test('"I refer not to X, but to Y" is a correction', () => {
    assert.equal(hasMidSentencePivot('The national pastime: I refer not to baseball, but to the acquisition of real estate.'), false);
  });
  test('a quote that runs past the sentence stop is not expanded', () => {
    const src = 'A playwright isn’t there to judge, but to render life, as Mr. Norris so superbly does in this play. It is great.';
    assert.equal(expandToSentenceStart('Mr. Norris so superbly does in this play. It is great.', src), null);
  });
  test('a dangling opening quote mark is dropped from the expansion', () => {
    const src = 'Intro line here.\n“The writing is sharp and the staging is clean, as Mr. Norris so superbly shows in this play. And then more,” she said.';
    assert.equal(expandToSentenceStart('Mr. Norris so superbly shows in this play.', src), 'The writing is sharp and the staging is clean, as Mr. Norris so superbly shows in this play.');
  });
});

// BRO-7598 did-it-work: the lead word alone over-fired on complete clauses.
describe('startsMidClause needs a real gap, not just the lead word', () => {
  const { startsMidClause } = require('../../scripts/lib/pull-quote-guards.js');
  test('"in which" / "with which" start a complete clause', () => {
    const src = 'Claire Foy and Sam Troughton are also first-rate in a play in which Bartlett exhilaratingly combines the domestic and the epic.';
    assert.strictEqual(startsMidClause('Bartlett exhilaratingly combines the domestic and the epic.', src), false);
  });
  test('"as X is ..." and "other than X steals ..." read on their own', () => {
    const a = 'You will leave satisfied and excited, as Some Like It Hot is a wildly entertaining farce from start to finish.';
    assert.strictEqual(startsMidClause('Some Like It Hot is a wildly entertaining farce from start to finish.', a), false);
    const b = 'There is really nothing else to say other than the Seinfeld alum steals the show from the second the action begins.';
    assert.strictEqual(startsMidClause('The Seinfeld alum steals the show from the second the action begins.', b), false);
  });
  test('real gaps are still caught: pro-verb, reporting verb + comma, bare object relative', () => {
    const a = 'It is fascinating entertainment, as A Bright Room Called Day does, consistently.';
    assert.strictEqual(startsMidClause('A Bright Room Called Day does, consistently.', a), true);
    const b = 'Its run was made possible by another shipwreck, but as Titanique joyously shows, mirth and song can grow out of disaster.';
    assert.strictEqual(startsMidClause('Titanique joyously shows, mirth and song can grow out of disaster.', b), true);
    const c = 'This is the arc of the text, which Butler brings vibrantly, lovingly to life in a turn of real force.';
    assert.strictEqual(startsMidClause('Butler brings vibrantly, lovingly to life in a turn of real force.', c), true);
  });
});

describe('parenthetical-start quotes (BRO-7675)', () => {
  const g = require('../../scripts/lib/pull-quote-guards.js');
  const bad = [
    '(Lewis’s existence also happens to save the show from the dated sexism of Luisa’s damsel-in-distress fantasies.)',
    '(Courtesy Matthew Murphy/BroadwaySF) The stage musical “Some Like It Hot,” now at the Orpheum, is a delight.',
    '“(One, two, three) No, the brilliance of Bartlett Sher’s revival lies elsewhere.',
  ];
  const good = [
    'But this Fantasticks remains unshowy: Music director Rick Hip-Flores coaxes his cast to under-sing.',
    'A superb revival (the best in years) that earns every laugh.',
    '“Heartfelt and funny,” and a triumph.',
  ];
  for (const q of bad) {
    test(`rejects: ${q.slice(0, 40)}`, () => {
      assert.equal(g.startsAsFragment(q), true, 'rebuild soft-defers it');
      assert.equal(g.llmQuoteHardRejectReason(q, ''), 'parenthetical-start', 'LLM quote hard-rejected');
    });
  }
  for (const q of good) {
    test(`keeps: ${q.slice(0, 40)}`, () => {
      assert.equal(g.startsAsFragment(q), false);
      assert.equal(g.llmQuoteHardRejectReason(q, ''), null);
    });
  }
});

describe('leading parenthetical aside is cut or ranked last (BRO-7675)', () => {
  const g = require('../../scripts/lib/pull-quote-guards.js');
  test('closed aside + capitalised sentence: aside cut, critic sentence kept', () => {
    assert.equal(g.stripLeadingParenAside('(Courtesy Matthew Murphy/BroadwaySF) The stage musical is a delight.'), 'The stage musical is a delight.');
    assert.equal(g.stripLeadingParenAside('(I am also a fan of “Part II,” though not so much “Part III.”) It is an absolutely superb show.'), 'It is an absolutely superb show.');
    assert.equal(g.stripLeadingParenAside('(Fortunately, she can be bribed with ice cream). This unusual character works.'), 'This unusual character works.');
    assert.equal(g.stripLeadingParenAside('“(One, two, three) No, the brilliance lies elsewhere.'), 'No, the brilliance lies elsewhere.');
  });
  test('leftover list bullet or arrow is cut; a dash that belongs to the text stays', () => {
    assert.equal(g.stripLeadingParenAside("- Coward's wit is too often blunted."), "Coward's wit is too often blunted.");
    assert.equal(g.stripLeadingParenAside('\u2013 Kunene and the King is made remarkably light.'), 'Kunene and the King is made remarkably light.');
    assert.equal(g.stripLeadingParenAside('--> \u201cSay your prayers and be good.\u201d Rooted in folklore.'), '\u201cSay your prayers and be good.\u201d Rooted in folklore.');
    assert.equal(g.stripLeadingParenAside('\u2022 (Courtesy Joan Marcus) The show is a delight.'), 'The show is a delight.');
    assert.equal(g.stripLeadingParenAside('- \u00abBravo\u00bb, says the chorus.'), '\u00abBravo\u00bb, says the chorus.');
    assert.equal(g.stripLeadingParenAside('\u2014 Then the show catches fire.'), 'Then the show catches fire.');
    assert.equal(g.stripLeadingParenAside('* * * The show'), '* * * The show');
    for (const q of ['-ish at best, the staging drags.', '\u2014and then the show catches fire.', '-5 degrees outside, the theatre was warm.']) {
      assert.equal(g.stripLeadingParenAside(q), q);
    }
  });
  test('unclosed aside, or aside followed by a fragment, is left for the guard to defer', () => {
    for (const q of ['(Lewis’s existence also happens to save the show from the dated sexism', '("Bloody Bloody Andrew Jackson"), is very nearly as good.']) {
      assert.equal(g.stripLeadingParenAside(q), q);
      assert.ok(g.PAREN_ASIDE_START_RE.test(q));
    }
  });
  test('non-string input (no snap found) passes through', () => {
    assert.equal(g.stripLeadingParenAside(null), null);
  });
  test('a quote without a leading aside is untouched', () => {
    const q = 'A superb revival (the best in years) that earns every laugh.';
    assert.equal(g.stripLeadingParenAside(q), q);
  });
  test('a parenthetical-aside deferral loses to every other deferral and never beats an accepted quote', () => {
    const aside = { rank: 1, excerpt: '(an aside', reason: 'parenthetical-aside' };
    const frag = { rank: 9, excerpt: 'and the score is sublime.', reason: 'lowercase-fragment' };
    const over = { rank: 9, excerpt: 'Overlong but real…', reason: 'overlong' };
    assert.equal(g.pickExcerptCandidate({ deferred: [aside, frag, over] }), 'and the score is sublime.');
    assert.equal(g.pickExcerptCandidate({ deferred: [aside, over] }), 'Overlong but real…');
    assert.equal(g.pickExcerptCandidate({ accepted: { rank: 99, excerpt: 'Body sentence.' }, deferred: [aside] }), 'Body sentence.');
    assert.equal(g.pickExcerptCandidate({ deferred: [aside] }), '(an aside', 'still never quote-less');
  });
  test('a stored LLM quote opening on "(" counts as absent', () => {
    if (typeof g.hasUsableLlmQuote !== 'function') return;
    assert.equal(g.hasUsableLlmQuote({ llmPullQuote: '(Lewis’s existence also happens to save the show.)' }), false);
  });
});
