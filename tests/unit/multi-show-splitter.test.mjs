/**
 * multi-show-splitter — splits Vulture/NYT multi-show roundup articles into
 * per-show sections.
 *
 * Background (Notion 352637c5-416f-819c): Vulture/NYT/New Yorker publish
 * critic-roundup pieces where one critic reviews 2+ shows in a single article.
 * The per-show section is bounded by photo-credit captions ("Photo:" /
 * "Credit..."). Without per-show splitting, only one show gets the review and
 * the rest get nothing — or worse, the single attribution goes to the wrong
 * show and the LLM rejects the file as wrong_show.
 *
 * Tests cover:
 * 1. Vulture-style boundaries (bare title in caption, "Photo:" tag).
 * 2. NYT-style boundaries (curly-quoted title, "Credit..." tag).
 * 3. NYT descriptor-shape captions (no "at <Venue>", just descriptor).
 * 4. Negative — single-show reviews don't split.
 * 5. Negative — common-noun titles in prose ("rope tricks", "girls' outfits",
 *    "the heart of the story") don't false-anchor.
 * 6. Common short-word titles (Jack/Six/Cats) don't false-anchor on
 *    actor first names.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  splitMultiShowArticle,
  findCaptionAnchors,
  findTailrunAnchors,
  getTitleVariants,
} = require('../../scripts/lib/multi-show-splitter.js');

const SHOWS = [
  { id: 'kenrex-off-broadway-2026', title: 'KENREX', category: 'off-broadway' },
  { id: 'rheology-off-broadway-2026', title: 'Rheology', category: 'off-broadway' },
  { id: 'anonymous-off-broadway-2026', title: 'Anonymous', category: 'off-broadway' },
  { id: 'the-reservoir-off-broadway-2026', title: 'The Reservoir', category: 'off-broadway' },
  { id: 'the-dinosaurs-off-broadway-2026', title: 'The Dinosaurs', category: 'off-broadway' },
  { id: 'blackout-songs-off-broadway-2026', title: 'Blackout Songs', category: 'off-broadway' },
  { id: 'the-lost-boys-2026', title: 'The Lost Boys', category: 'broadway' },
  { id: 'masquerade-off-broadway-2025', title: 'Masquerade', category: 'off-broadway' },
  { id: 'tricks-1973', title: 'Tricks', category: 'broadway' },
  { id: 'jack-a-night-on-the-town-with-john-barrymore-1996', title: 'Jack: A Night on the Town with John Barrymore', category: 'broadway' },
];

describe('getTitleVariants', () => {
  test('produces single lowercase variant for a plain title', () => {
    assert.deepStrictEqual(getTitleVariants('Rheology'), ['rheology']);
  });

  test('does NOT produce a single-word variant from a long title with colon', () => {
    // "Jack: A Night..." → must not produce "jack" — too generic, false-matches
    // actor first names in photo captions.
    const v = getTitleVariants('Jack: A Night on the Town with John Barrymore');
    assert.ok(!v.includes('jack'), 'must not produce single-word "jack"');
    assert.ok(v.includes('jack: a night on the town with john barrymore'));
  });

  test('produces multi-word colon split when pre-colon has 2+ words', () => {
    const v = getTitleVariants('Hamilton: An American Musical');
    assert.ok(v.includes('hamilton: an american musical'));
    // Hamilton is single word; pre-colon = "hamilton" (1 word, 8 chars >= 7) → emit
    assert.ok(v.includes('hamilton'));
  });

  test('does not strip "the" when remainder is too short', () => {
    // "The Six" → don't produce "six" (too generic)
    const v = getTitleVariants('The Six');
    assert.ok(!v.includes('six'));
  });
});

describe('splitMultiShowArticle — Vulture-style', () => {
  test('splits 2-show Vulture-style article on photo-caption boundaries', () => {
    // Synthetic fixture mirroring the real Vulture Kenrex/Rheology article.
    const text =
      'Jack Holden and John Patrick Elliott in Kenrex, at the Lucille Lortel.\n' +
      ' Photo: Matthew Murphy\n\n' +
      ('A long review of Kenrex. '.repeat(40)) + '\n\n' +
      'Shayok Misha Chowdhury and Bulbul Chakraborty in Rheology, at Playwrights Horizons.\n' +
      ' Photo: Maria Baranova\n\n' +
      ('A long review of Rheology. '.repeat(40)) + '\n\n' +
      'Kenrex is at the Lucille Lortel Theater through June 27. Rheology is at Playwrights Horizons through May 16.';

    const sections = splitMultiShowArticle(text, SHOWS);
    assert.strictEqual(sections.length, 2, `expected 2 sections, got ${sections.length}`);
    const ids = sections.map(s => s.showId).sort();
    assert.deepStrictEqual(ids, ['kenrex-off-broadway-2026', 'rheology-off-broadway-2026']);
    for (const s of sections) {
      assert.ok(s.sectionText.length >= 500, `section ${s.showId} too short: ${s.sectionText.length}`);
      assert.strictEqual(s.anchorKind, 'caption');
    }
  });

  test('does not split when only one show has a strong anchor', () => {
    // Single-show review of Rheology that mentions Kenrex in passing — not a
    // multi-show roundup.
    const text =
      'A review of Rheology, the play by Shayok Misha Chowdhury at Playwrights Horizons.\n' +
      'Photo: Maria Baranova\n\n' +
      ('Rheology is brilliant. '.repeat(60)) +
      ' Compared to other recent shows, it stands out — Kenrex was good too. ' +
      ('More about Rheology. '.repeat(40));

    const sections = splitMultiShowArticle(text, SHOWS);
    assert.strictEqual(sections.length, 0, 'single-show review must not split');
  });
});

describe('splitMultiShowArticle — NYT-style', () => {
  test('splits NYT 4-show feature on Credit... captions (curly-quoted titles)', () => {
    // Mirrors the actual NYT "dinosaurs-blackout-songs-reservoir-anonymous"
    // feature shape.
    const text =
      'Lead paragraph about addiction-themed plays.' + (' Padding '.repeat(80)) + '\n\n' +
      'Jesse Metz, center in orange shirt, with the cast of “Anonymous” at Spit&Vigor’s theater.Credit...Giancarlo Osabe' + ('Body about Anonymous. '.repeat(50)) + '\n\n' +
      'Maria Wirries and Owen Teague in “Blackout Songs” at the Robert W. Wilson MCC Theater Space. Credit...Emilio Madrid' + ('Body about Blackout Songs. '.repeat(40)) + '\n\n' +
      'A character in “The Reservoir,” Jake Brasch’s intergenerational comedy about addiction.Credit...Sara Krulwich/The New York Times' + ('Body about The Reservoir. '.repeat(40)) + '\n\n' +
      'Keilly McQuail in “The Dinosaurs” at Playwrights Horizons.Credit...Sara Krulwich/The New York Times' + ('Body about The Dinosaurs. '.repeat(40));

    const sections = splitMultiShowArticle(text, SHOWS);
    assert.strictEqual(sections.length, 4, `expected 4 sections, got ${sections.length}`);
    const ids = sections.map(s => s.showId).sort();
    assert.deepStrictEqual(ids, [
      'anonymous-off-broadway-2026',
      'blackout-songs-off-broadway-2026',
      'the-dinosaurs-off-broadway-2026',
      'the-reservoir-off-broadway-2026',
    ]);
  });
});

describe('splitMultiShowArticle — false-positive guards', () => {
  test('does not split when a common-noun title appears in prose ("rope tricks")', () => {
    // Caption mentions "rope tricks" — generic plural noun, not a production
    // credit for the show "Tricks" (1973).
    const text =
      'Madame Giry just may take you by the hand and ask you to dance at this Masquerade Ball.\n' +
      'Photo: Carol Rosegg\n\n' +
      ('Body about Masquerade. '.repeat(60)) + '\n\n' +
      'The carnival scene is ornamented with a blockhead, a fire eater and a performer doing rope tricks.\n' +
      'Photo: Carol Rosegg\n\n' +
      ('More body about Masquerade. '.repeat(50));

    const sections = splitMultiShowArticle(text, SHOWS);
    // Should NOT split: "rope tricks" is prose, not a production credit for
    // the show "Tricks". Masquerade has no production-credit context here
    // either ("at this Masquerade Ball" — also prose).
    assert.strictEqual(sections.length, 0, `expected 0 sections, got ${sections.length}`);
  });

  test('does not split on "the heart of the story" prose for show "The Lost Boys"', () => {
    const text =
      'A character in the lost boys movie returns to stage.\n' +
      'Photo: Carol Rosegg\n\n' +
      ('Body about The Lost Boys. '.repeat(60)) + '\n\n' +
      'Two young men and a woman sing while holding pinkies. The struggling family at the heart of the story.\n' +
      'Photo: Sara Krulwich\n\n' +
      ('More about The Lost Boys. '.repeat(50));

    const sections = splitMultiShowArticle(text, SHOWS);
    // "the story" must NOT match "The Story" — there's no production-credit
    // anchor (no "in 'The Story', at <Venue>" or "in 'The Story', <descriptor>")
    // in the second caption.
    assert.strictEqual(sections.length, 0, 'must not split on prose noun match');
  });

  test('does not match an actor first name against a long colon-titled show', () => {
    // "Jack: A Night on the Town with John Barrymore" must NOT match the
    // actor name "Jack Holden" in a Kenrex caption.
    const text =
      'Jack Holden and John Patrick Elliott in Kenrex, at the Lucille Lortel.\n' +
      ' Photo: Matthew Murphy\n\n' +
      ('Long review body about Kenrex. '.repeat(60)) + '\n\n' +
      'Different paragraph here. ' + ('Body B '.repeat(40));

    const sections = splitMultiShowArticle(text, SHOWS);
    // Only one strong anchor (Kenrex) — not enough to split.
    assert.strictEqual(sections.length, 0, 'single-anchor article must not split');
  });
});

describe('splitMultiShowArticle — production-credit context required', () => {
  test('does not match bare title without "in"/"with"/"of" preceding it', () => {
    // Title appears bare in prose, no production-credit verb leading in.
    const text =
      'I attended Anonymous last week. Then I caught The Dinosaurs.\n' +
      'Photo: someone\n\n' +
      ('Padding '.repeat(80)) + '\n\n' +
      'Body again.\n' +
      'Photo: someone\n\n' +
      ('More padding '.repeat(60));

    const sections = splitMultiShowArticle(text, SHOWS);
    assert.strictEqual(sections.length, 0, 'bare-title prose must not split');
  });

  test('matches when title is in production-credit context with quotes', () => {
    const text =
      'Cast members in “Anonymous” at the Spit&Vigor theater.\n' +
      'Photo: someone\n\n' +
      ('Body about Anonymous. '.repeat(60)) + '\n\n' +
      'Other cast members with the cast of “The Dinosaurs” at Playwrights Horizons.\n' +
      'Photo: someone\n\n' +
      ('Body about The Dinosaurs. '.repeat(60));

    const sections = splitMultiShowArticle(text, SHOWS);
    assert.strictEqual(sections.length, 2);
  });
});

describe('findCaptionAnchors', () => {
  test('returns one anchor per single-show caption', () => {
    const text =
      'Cast members in Rheology, at Playwrights Horizons.\n' +
      'Photo: Maria Baranova\n\n' +
      'Body. '.repeat(50);

    const anchors = findCaptionAnchors(text, SHOWS);
    assert.strictEqual(anchors.length, 1);
    assert.strictEqual(anchors[0].showId, 'rheology-off-broadway-2026');
    assert.strictEqual(anchors[0].kind, 'caption');
  });

  test('skips ambiguous captions naming 2+ shows', () => {
    const text =
      'A composite shot showing the casts in Rheology and in Kenrex on the same stage at the Lucille Lortel.\n' +
      'Photo: someone\n\n' +
      'Body. '.repeat(40);

    const anchors = findCaptionAnchors(text, SHOWS);
    assert.strictEqual(anchors.length, 0, 'multi-show caption is ambiguous; must skip');
  });
});
