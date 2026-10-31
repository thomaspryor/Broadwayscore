/**
 * Regression tests for WET (WestEndTheatre.com) title extraction and show matching.
 *
 * These test cases come from real WP API post titles observed in CI on 2026-04-08
 * (884 posts). They protect against regressions in extractShowTitle() when adding
 * new prefix/suffix stripping patterns.
 *
 * Pattern: require() the real functions, never copy logic into tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractShowTitle, stripHtml } = require('../../scripts/scrape-westendtheatre-roundups.js');
const { matchTitleToShow, loadShows } = require('../../scripts/lib/show-matching.js');

const allShows = loadShows();

// Helper: extract + match in one step
function extractAndMatch(wpTitle) {
  const showTitle = extractShowTitle(wpTitle);
  const result = matchTitleToShow(showTitle, allShows, { market: 'west-end' });
  return { extracted: showTitle, confidence: result?.confidence || null, matched: result?.show?.title || null };
}

// ─── extractShowTitle: prefix stripping ───

describe('extractShowTitle — prefix stripping', () => {
  test('strips "Reviews of"', () => {
    assert.strictEqual(extractShowTitle('Reviews of Hadestown at the Lyric'), 'Hadestown');
  });

  test('strips "The reviews are in for"', () => {
    assert.strictEqual(extractShowTitle('The reviews are in for Wicked'), 'Wicked');
  });

  test('strips "Reviews round-up of"', () => {
    assert.strictEqual(extractShowTitle('Reviews round-up of Manic Street Creature'), 'Manic Street Creature');
  });

  test('strips "West End reviews of"', () => {
    assert.strictEqual(extractShowTitle('West End reviews of Marie & Rosetta'), 'Marie & Rosetta');
  });

  test('strips "What the critics think about"', () => {
    assert.strictEqual(extractShowTitle('What the critics think about 2:22 A Ghost Story'), '2:22 A Ghost Story');
  });

  test('strips "What the critics are saying about"', () => {
    assert.strictEqual(extractShowTitle('What the critics are saying about Wicked'), 'Wicked');
  });
});

// ─── extractShowTitle: suffix/middle stripping ───

describe('extractShowTitle — suffix and middle stripping', () => {
  test('strips "Reviews Round-up – Venue [Updated]"', () => {
    assert.strictEqual(
      extractShowTitle('Into the Woods Reviews Round-up – Bridge Theatre London [Updated]'),
      'Into the Woods'
    );
  });

  test('strips "in the West End Reviews Round-up"', () => {
    assert.strictEqual(
      extractShowTitle('Oliver! in the West End Reviews Round-up – Gielgud Theatre London [Updated]'),
      'Oliver!'
    );
  });

  test('strips "reviews: subtitle question"', () => {
    assert.strictEqual(
      extractShowTitle('Oh, Mary! Reviews: Is it the most outrageous comedy in London?'),
      'Oh, Mary!'
    );
  });

  test('strips "reviews: editorial subtitle"', () => {
    assert.strictEqual(
      extractShowTitle("American Psycho reviews: Is Rupert Goold's 2026 London revival a killer?"),
      'American Psycho'
    );
  });

  test('strips [Updated] tag', () => {
    assert.strictEqual(
      extractShowTitle('The Producers Reviews Round-up [Updated] – Garrick Theatre London'),
      'The Producers'
    );
  });

  test('strips trailing star ratings', () => {
    assert.strictEqual(
      extractShowTitle('Mary Poppins review round-up at the Prince Edward Theatre in London ★★★★'),
      'Mary Poppins'
    );
  });

  test('strips "reviews round-up –" (trailing dash)', () => {
    assert.strictEqual(
      extractShowTitle("I'm Sorry, Prime Minister reviews round-up –"),
      "I'm Sorry, Prime Minister"
    );
  });

  test('strips "reviews round-up" without dash', () => {
    assert.strictEqual(extractShowTitle('Man and Boy reviews round-up'), 'Man and Boy');
    assert.strictEqual(extractShowTitle('Arcadia reviews round-up'), 'Arcadia');
  });

  test('strips "in London"', () => {
    assert.strictEqual(extractShowTitle('The Holy Rosenbergs in London'), 'The Holy Rosenbergs');
  });

  test('strips trailing "West End"', () => {
    assert.strictEqual(
      extractShowTitle('Paranormal Activity West End Reviews Round-up – Ambassadors Theatre London'),
      'Paranormal Activity'
    );
  });
});

// ─── extractShowTitle: venue stripping ───

describe('extractShowTitle — venue stripping', () => {
  test('strips named venue: Donmar', () => {
    assert.strictEqual(
      extractShowTitle('Critics on Into the Woods at the Donmar'),
      'Into the Woods'
    );
  });

  test('strips named venue: Victoria Palace', () => {
    assert.strictEqual(
      extractShowTitle('Hamilton at the Victoria Palace – Reviews'),
      'Hamilton'
    );
  });

  test('strips named venue: Kit Kat Club', () => {
    assert.strictEqual(
      extractShowTitle('Cabaret at the Kit Kat Club – Reviews'),
      'Cabaret'
    );
  });

  test('strips generic venue with Theatre suffix', () => {
    assert.strictEqual(
      extractShowTitle('Starlight Express at the Troubadour Wembley Park Theatre'),
      'Starlight Express'
    );
  });

  test("strips possessive West End's venue", () => {
    assert.strictEqual(
      extractShowTitle("Reviews round-up of The Unlikely Pilgrimage of Harold Fry at the West End's Theatre Royal Haymarket"),
      'The Unlikely Pilgrimage of Harold Fry'
    );
  });

  test('strips named venue: Gillian Lynne Theatre', () => {
    assert.strictEqual(
      extractShowTitle('The Lehman Trilogy Reviews Round-up – Gillian Lynne Theatre [Updated]'),
      'The Lehman Trilogy'
    );
  });
});

// ─── extractShowTitle: preserves show titles correctly ───

describe('extractShowTitle — preserves titles', () => {
  test('simple title passthrough', () => {
    assert.strictEqual(extractShowTitle('Operation Mincemeat'), 'Operation Mincemeat');
  });

  test('title with punctuation', () => {
    assert.strictEqual(extractShowTitle("Teeth 'n' Smiles Review Round-up –"), "Teeth 'n' Smiles");
  });

  test('title with ampersand', () => {
    assert.strictEqual(extractShowTitle('Romeo & Juliet'), 'Romeo & Juliet');
  });
});

// ─── Full pipeline: extractShowTitle + matchTitleToShow ───

describe('WET title → show match (full pipeline)', () => {
  // These MUST match at HIGH confidence
  const highConfidenceExpected = [
    ['The reviews are in for Wicked', 'Wicked'],
    ['Operation Mincemeat', 'Operation Mincemeat'],
    ['Into the Woods Reviews Round-up – Bridge Theatre London [Updated]', 'Into the Woods'],
    ['Oliver! in the West End Reviews Round-up – Gielgud Theatre London [Updated]', 'Oliver!'],
    ['Oh, Mary! Reviews: Is it the most outrageous comedy in London?', 'Oh, Mary!'],
    ['The Producers Reviews Round-up [Updated] – Garrick Theatre London', 'The Producers'],
    ['The Lehman Trilogy Reviews Round-up – Gillian Lynne Theatre [Updated]', 'The Lehman Trilogy'],
    ['Romeo & Juliet', 'Romeo and Juliet'],
    ['Reviews round-up of The Comedy About Spies in the West End [Updated]', 'The Comedy About Spies'],
    ['Summerfolk reviews: What do the critics think of the National Theatre\'s new production?', 'Summerfolk'],
    ['Reviews round-up of Manic Street Creature', 'Manic Street Creature'],
    ['The Holy Rosenbergs in London', 'The Holy Rosenbergs'],
    ['West End reviews of Marie & Rosetta', 'Marie & Rosetta'],
    ["I\u2019m Sorry, Prime Minister reviews round-up \u2013", "I\u2019m Sorry, Prime Minister"],
    ['Man and Boy reviews round-up', 'Man and Boy'],
    ['Arcadia reviews round-up', 'Arcadia'],
    ['High Noon Reviews: Billy Crudup & Denise Gough in a divisive frontier standoff', 'High Noon'],
    ["Woman in Mind reviews: Sheridan Smith Shines, but Does Ayckbourn's play still stand up?", 'Woman in Mind'],
    ['Reviews of Hadestown at the Lyric', 'Hadestown'],
    ['Mary Poppins review round-up at the Prince Edward Theatre in London ★★★★', 'Mary Poppins'],
    ["Reviews round-up of The Unlikely Pilgrimage of Harold Fry at the West End's Theatre Royal Haymarket", 'The Unlikely Pilgrimage of Harold Fry'],
    ['Reviews of The Devil Wears Prada at the Dominion', 'The Devil Wears Prada'],
    // Mischief Theatre's "Christmas Carol Goes Wrong" entered the dataset as a
    // real West End show (christmas-carol-goes-wrong-west-end-2026). It is a
    // genuine title, not a parody fuzzy-match — must resolve to itself, not to
    // "A Christmas Carol". (Was previously a mustNotMatchHigh case; flipped when
    // the real show was added — 2026-06-22.)
    ['Christmas Carol Goes Wrong', 'Christmas Carol Goes Wrong'],
  ];

  for (const [wpTitle, expectedShow] of highConfidenceExpected) {
    test(`HIGH: "${wpTitle.substring(0, 60)}..." → ${expectedShow}`, () => {
      const result = extractAndMatch(wpTitle);
      assert.strictEqual(result.confidence, 'high', `Expected high confidence for "${wpTitle}", got ${result.confidence}. Extracted: "${result.extracted}"`);
      assert.strictEqual(result.matched, expectedShow);
    });
  }

  // These MUST NOT match at high confidence (wrong-show prevention)
  const mustNotMatchHigh = [
    'Best West End Shows This Week',
    'Reviews Round Up',
    'Review: A Brand New Show Nobody Knows',
  ];

  for (const wpTitle of mustNotMatchHigh) {
    test(`REJECT: "${wpTitle}" must not match high`, () => {
      const result = extractAndMatch(wpTitle);
      assert.notStrictEqual(result.confidence, 'high', `"${wpTitle}" should NOT match high but matched "${result.matched}"`);
    });
  }

  // These should produce NO match at all
  const noMatchExpected = [
    'Reviews of Mamma Mia! The Party',
    'What the critics say about The Phantom Returns',
  ];

  for (const wpTitle of noMatchExpected) {
    test(`NO MATCH: "${wpTitle}"`, () => {
      const result = extractAndMatch(wpTitle);
      assert.strictEqual(result.matched, null, `"${wpTitle}" should not match any show but matched "${result.matched}"`);
    });
  }
});

describe('isCachedNoRatings — negative-result cache invalidation', () => {
  const { isCachedNoRatings, NO_RATINGS_RECHECK_DAYS } =
    require('../../scripts/scrape-westendtheatre-roundups.js');

  const NOW = new Date('2026-06-11T00:00:00Z').getTime();
  const clock = () => NOW;
  const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
  const post = { id: 123, modified: '2026-05-01T10:00:00', date: '2026-04-01T10:00:00' };

  test('fresh entry with matching modified stamp → skip (true)', () => {
    const cache = { posts: { 123: { modified: post.modified, checkedAt: daysAgo(5) } } };
    assert.strictEqual(isCachedNoRatings(cache, post, clock), true);
  });

  test('no entry → recheck (false)', () => {
    assert.strictEqual(isCachedNoRatings({ posts: {} }, post, clock), false);
  });

  test('post updated since cached (modified differs) → recheck (false)', () => {
    const cache = { posts: { 123: { modified: '2026-04-15T09:00:00', checkedAt: daysAgo(5) } } };
    assert.strictEqual(isCachedNoRatings(cache, post, clock), false);
  });

  test('entry older than recheck window → recheck (false, self-heals cached transient failures)', () => {
    const cache = { posts: { 123: { modified: post.modified, checkedAt: daysAgo(NO_RATINGS_RECHECK_DAYS + 1) } } };
    assert.strictEqual(isCachedNoRatings(cache, post, clock), false);
  });

  test('falls back to post.date when post.modified absent', () => {
    const noModPost = { id: 123, date: '2026-04-01T10:00:00' };
    const cache = { posts: { 123: { modified: noModPost.date, checkedAt: daysAgo(2) } } };
    assert.strictEqual(isCachedNoRatings(cache, noModPost, clock), true);
  });
});
