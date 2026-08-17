// TESTS-VS-DERIVED-DATA-EXEMPT: structural — asserts pure guard-function
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
