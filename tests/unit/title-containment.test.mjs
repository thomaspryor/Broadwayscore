/**
 * BRO-4953 (GitHub #1018): "The Heart" (Laura Pels, 2026) took the 2024 roundup
 * for "The Heart of Rock and Roll", and four of its excerpts went live before
 * the show opened. The word matcher accepts any longer title containing every
 * target word; these tests pin the containing-title guard that now rejects
 * them, using the real headings of the poisoned archive pages it found.
 *
 * Run: node --test tests/unit/title-containment.test.mjs
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: behaviour is pinned on fixture show lists; the two data/shows.json-backed cases skip unless the pair exists and assert only that the guard fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findContainingTitleSibling, buildContainingTitleIndex, phraseNorm, containsTitle,
} = require('../../scripts/lib/title-containment');
const { validatePageMatchesShow } = require('../../scripts/lib/page-validator');
const { validateRoundupPageTitle, matchTitleToShow } = require('../../scripts/lib/show-matching');

const SHOWS = [
  'The Heart', 'The Heart of Rock and Roll', 'Home', 'Fun Home', 'Once', 'Once Upon a Mattress',
  'Cats', 'Cats: The Jellicle Ball', 'Sea Wall', 'Sea Wall/A Life', 'Cinderella',
  "Rodgers + Hammerstein's Cinderella", 'Bad Cinderella', 'Les Misérables',
  'Les Misérables: The Arena Concert Spectacular', 'Hadestown', 'Hadestown: The Musical',
  '& Juliet', 'Romeo and Juliet', 'Art',
].map((title, i) => ({ id: `show-${i}`, title }));
const opts = { shows: SHOWS };

// Real <title>/heading text of the poisoned archive pages (BRO-4953 sweep).
const POISONED = [
  ['The Heart', "Reviews: What Critics Are Saying About Broadway's The Heart of Rock and Roll | Playbill"],
  ['Home', 'Review Roundup: FUN HOME Opens on Broadway- ALL the Reviews!'],
  ['Once', 'Reviews: Are Critics in Love With the Once Upon a Mattress Broadway Revival? | Playbill'],
  ['Cats', 'Reviews: CATS: The Jellicle Ball Reviews Are In! - News from New York City Theatre'],
  ['Sea Wall', 'Sea Wall / A Life - Did They Like It?'],
  ['Cinderella', "RODGERS + HAMMERSTEIN'S CINDERELLA Broadway Reviews | BroadwayWorld"],
  ['Cinderella', 'Review Roundup: Critics React To BAD CINDERELLA On Broadway'],
  ['Les Misérables', 'Review Roundup: LES MISERABLES: THE ARENA CONCERT SPECTACULAR Opens At Radio City'],
  ['& Juliet', 'Romeo and Juliet - Did They Like It?'],
];

for (const [title, heading] of POISONED) {
  test(`rejects "${title}" for heading naming a longer show: ${heading.slice(0, 50)}`, () => {
    const hit = findContainingTitleSibling(heading, title, opts);
    assert.ok(hit, `expected a containing-title sibling for "${title}"`);
  });
}

test('accepts the target\'s own page', () => {
  assert.equal(findContainingTitleSibling('THE HEART Off-Broadway Reviews | BroadwayWorld', 'The Heart', opts), null);
  assert.equal(findContainingTitleSibling('Review Roundup: CATS Returns to London', 'Cats', opts), null);
  assert.equal(findContainingTitleSibling('& Juliet - Did They Like It?', '& Juliet', opts), null);
});

test('accepts when the target also appears on its own beside the longer title', () => {
  const heading = 'Home review: a quieter cousin of Fun Home';
  assert.equal(findContainingTitleSibling(heading, 'Home', opts), null);
});

test('a non-distinguishing suffix is not a different show', () => {
  // "Hadestown: The Musical" adds only generic words, so it is not indexed as a sibling.
  const index = buildContainingTitleIndex(SHOWS);
  assert.equal(index.get('hadestown'), undefined);
  assert.equal(findContainingTitleSibling('Hadestown: The Musical Reviews', 'Hadestown', opts), null);
});

test('word boundaries: "Art" is not found inside "smart"', () => {
  assert.equal(containsTitle('a smart new play', 'art', phraseNorm), false);
  assert.equal(containsTitle('art, revisited', 'art', phraseNorm), true);
});

test('HTML entities in raw <title> text are decoded, not read as "and"', () => {
  assert.equal(phraseNorm('Broadway&#039;s The Heart'), "broadway s the heart");
  assert.equal(phraseNorm('Romeo &amp; Juliet'), 'romeo and juliet');
  assert.ok(findContainingTitleSibling("Reviews: Broadway&#039;s The Heart of Rock and Roll | Playbill", 'The Heart', opts));
});

test('CONTAINING_TITLE_GUARD_OFF=1 disables the guard', () => {
  process.env.CONTAINING_TITLE_GUARD_OFF = '1';
  try {
    assert.equal(findContainingTitleSibling(POISONED[0][1], 'The Heart', opts), null);
  } finally {
    delete process.env.CONTAINING_TITLE_GUARD_OFF;
  }
  assert.ok(findContainingTitleSibling(POISONED[0][1], 'The Heart', opts));
});

test('no shows (missing shows.json) leaves the guard inert', () => {
  assert.equal(findContainingTitleSibling(POISONED[0][1], 'The Heart', { shows: [] }), null);
});

test('validatePageMatchesShow rejects the real Heart of Rock and Roll roundup for The Heart', async () => {
  const html = `<html><head><title>${POISONED[0][1]}</title></head><body><h1></h1></body></html>`;
  const r = await validatePageMatchesShow(html, 'The Heart', { skipLlm: true, openingYear: 2026, shows: SHOWS });
  assert.equal(r.valid, false);
  assert.match(r.reason, /containing-title sibling/);
  // Without the sibling in shows, the old word-match path still accepts it: the guard is what rejects.
  const before = await validatePageMatchesShow(html, 'The Heart', { skipLlm: true, openingYear: 2026, shows: [] });
  assert.equal(before.valid, true);
});

test('matchTitleToShow files a longer title under the longer show, not the shorter one', () => {
  const shows = [
    { id: 'the-heart-off-broadway-2026', title: 'The Heart', slug: 'the-heart-off-broadway', openingDate: '2026-10-29' },
    { id: 'heart-of-rock-and-roll-2024', title: 'The Heart of Rock and Roll', slug: 'heart-of-rock-and-roll', openingDate: '2024-04-22' },
    { id: 'broadway-1987', title: 'Broadway', slug: 'broadway-1987', openingDate: '1987-01-01' },
    { id: 'big-fish-2013', title: 'Big Fish', slug: 'big-fish', openingDate: '2013-10-06' },
    { id: 'fish-off-broadway-2026', title: 'Fish', slug: 'fish-off-broadway', openingDate: '2026-01-01' },
  ];
  const id = (t) => matchTitleToShow(t, shows)?.show?.id;
  // "'n'" spelling fails the word match for the longer show; before BRO-4953 this went to The Heart.
  assert.equal(id("The Heart of Rock 'n' Roll"), 'heart-of-rock-and-roll-2024');
  assert.equal(id('Reviews: The Reviews For The Heart Of Rock and Roll Are In!'), 'heart-of-rock-and-roll-2024');
  assert.equal(id('BIG FISH Broadway Reviews | BroadwayWorld'), 'big-fish-2013');
  // The short show's own pages still match it.
  assert.equal(id('THE HEART Off-Broadway Reviews | BroadwayWorld'), 'the-heart-off-broadway-2026');
  assert.equal(id('FISH Off-Broadway Reviews'), 'fish-off-broadway-2026');
  // A single-show list (lbo-roundup-discover, opening-night-poller) has no
  // longer title of its own; the guard falls back to data/shows.json, which
  // knows Big Fish, so the Fish candidate is refused rather than accepted.
  if (findContainingTitleSibling('Big Fish', 'Fish')) {
    assert.equal(matchTitleToShow('BIG FISH Broadway Reviews', [shows[4]]), null);
  }
  assert.equal(matchTitleToShow('BIG FISH Broadway Reviews', [shows[4], shows[3]])?.show?.id, 'big-fish-2013');
});

test('validateRoundupPageTitle rejects it too (archive-cache guard + integrity audit path)', (t) => {
  const html = `<html><head><title>Review Roundup: FUN HOME Opens on Broadway- ALL the Reviews!</title></head></html>`;
  const own = `<html><head><title>Review Roundup: HOME Opens on Broadway</title></head></html>`;
  // validateRoundupPageTitle reads data/shows.json; skip (visibly) when core data is absent.
  const hit = findContainingTitleSibling('Fun Home', 'Home');
  if (!hit) { t.skip('data/shows.json lacks Fun Home/Home (core data not checked out)'); return; }
  const r = validateRoundupPageTitle(html, 'Home');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'containing-title-sibling');
  assert.equal(validateRoundupPageTitle(own, 'Home').ok, true);
});
