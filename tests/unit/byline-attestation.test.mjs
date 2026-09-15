/**
 * Regression test (BRO-3247, 2026-09-15): same-URL byline dedup crowned a
 * scraper-invented byline over the real one.
 *
 * Live failure: Safe House (off-Broadway, Theatre Row) had two review-text
 * files for ONE theaterscene.net URL — "Victor Gluck" (the real byline, printed
 * as "Posted on September 7, 2026 by Victor Gluck, Editor-in-Chief") and
 * "Scott Bennett" (a name appearing nowhere in the article). Both were
 * includable, both scored, same publishDate — so every tiebreak in
 * chooseCanonical tied and the final ALPHABETICAL FILENAME tiebreak picked
 * "scott-bennett". The automated dedup then wrote duplicateOf onto the REAL
 * review, suppressing it from the site.
 *
 * The cases below marked (SO) come from the /second-opinion review of the first
 * revision of this fix, which found three real false-positive modes: bare
 * substring matching, site-wide editor credits attesting someone else's byline,
 * and searching both files' text as one blob.
 *
 * These tests require() the real functions (CLAUDE.md rule 15) — no logic is
 * restated here, so a regression in the source fails the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBylineAttestedInText, normalizeForAttestation } =
  require('../../scripts/lib/byline-attestation.js');
const { chooseCanonicalForRebuild } =
  require('../../scripts/fix-circular-duplicate-pairs.js');

const ARTICLE = `Safe House A gripping and tense state-of-the-nation drama that is one of the
best plays of the year. Posted on September 7, 2026 by Victor Gluck, Editor-in-Chief in
Off-Broadway , Plays , Still Open. Karen Ziemba as Slipper and Marc Kudisch as Rock in a
scene from L.B. Browne's "Safe House" at Theatre Four on Theatre Row.`;

test('the printed byline is attested, the invented one is not', () => {
  assert.equal(isBylineAttestedInText('Victor Gluck', ARTICLE), true);
  assert.equal(isBylineAttestedInText('Scott Bennett', ARTICLE), false);
});

test('single-token bylines never count as attested (too weak a signal)', () => {
  // "Ross" is a real frontmezzjunkies byline; one common word proves nothing.
  assert.equal(isBylineAttestedInText('Ross', 'by the ross family bunker'), false);
});

test('attestation ignores accents and apostrophes', () => {
  // \b-style word boundaries break on exactly these characters —
  // memory/feedback_word_boundary_punct_titles.md.
  assert.equal(isBylineAttestedInText("Maureen O'Hara", 'by Maureen OHara'), true);
  assert.equal(isBylineAttestedInText('Beatrice Onions', 'reviewed by Beatrice Oñions'), true);
});

test('(SO) a name must sit on token boundaries, not merely be a substring', () => {
  // Bare String.includes matched both of these. The live shape: washpost had
  // BOTH "Joshua John Mackin" (real) and "John Mackin" (truncated phantom) for
  // one URL whose text reads "by Joshua John Mackin".
  assert.equal(isBylineAttestedInText('John Mackin', 'This opinion piece is by Joshua John Mackin, a writer'), false);
  assert.equal(isBylineAttestedInText('Joshua John Mackin', 'This opinion piece is by Joshua John Mackin, a writer'), true);
  assert.equal(isBylineAttestedInText('Ann Lee', 'reviewed by Mary Ann Leech directed'), false);
  assert.equal(isBylineAttestedInText('Sam Well', 'words by Sam Wells wrote'), false);
});

test('(SO) a bare mention in the prose is not a byline', () => {
  // Critics are named inside review prose constantly; only a byline counts.
  assert.equal(isBylineAttestedInText('Jane Doe', 'Jane Doe is quoted here but wrote nothing'), false);
  assert.equal(isBylineAttestedInText('Jane Doe', 'reviewed by Jane Doe'), true);
});

test('missing or unusable input is not attested', () => {
  assert.equal(isBylineAttestedInText(null, ARTICLE), false);
  assert.equal(isBylineAttestedInText('Victor Gluck', null), false);
  assert.equal(isBylineAttestedInText('Victor Gluck', ''), false);
  assert.equal(isBylineAttestedInText('', ARTICLE), false);
});

test('normalizeForAttestation folds punctuation and case to single spaces', () => {
  assert.equal(normalizeForAttestation("  O'Hara,   Maureen!  "), 'ohara maureen');
});

// --- the integration point that actually failed live -----------------------

function record(criticName, fullText) {
  return {
    criticName,
    fullText,
    outletId: 'theater-scene',
    url: 'https://www.theaterscene.net/plays/offbway-plays/safe-house-2/victor-gluck/',
    publishDate: '2026-09-08',
    contentTier: 'complete',
    assignedScore: 92,
    llmScore: { score: 92, confidence: 'high' },
  };
}

test('chooseCanonicalForRebuild keeps the attested byline, order-independently', () => {
  const A = 'theater-scene--victor-gluck.json';
  const B = 'theater-scene--scott-bennett.json';
  const dir = '/tmp/nonexistent-show-dir/safe-house-off-broadway-2026';

  // Alphabetically "scott-bennett" < "victor-gluck", so the pre-fix filename
  // tiebreak returned B here. Both argument orders must now return A.
  const forward = chooseCanonicalForRebuild(A, record('Victor Gluck', ARTICLE), B, record('Scott Bennett', ARTICLE), dir);
  const reverse = chooseCanonicalForRebuild(B, record('Scott Bennett', ARTICLE), A, record('Victor Gluck', ARTICLE), dir);

  assert.equal(forward.canonical, A, 'forward order must keep the real byline');
  assert.equal(reverse.canonical, A, 'reverse order must keep the real byline');
  assert.match(forward.reason, /printed in the article text/);
});

test('(SO) each file is judged on its OWN text, not the pair concatenated', () => {
  // theaterscene.net prints "by Victor Gluck, Editor-in-Chief" as a SITE credit
  // on pages other critics wrote. If the pair's texts are searched as one blob,
  // that credit in file A attests file B's invented "Victor Gluck" byline and
  // crowns the phantom. Judged per-file, B's own text never says it.
  const A = 'theater-scene--jane-doe.json';
  const B = 'theater-scene--victor-gluck.json';
  const aText = 'Review by Jane Doe. Posted by Victor Gluck, Editor-in-Chief.';
  const bText = 'A review with no byline line of its own at all.';
  const dir = '/tmp/nonexistent-show-dir/some-show';

  const r = chooseCanonicalForRebuild(A, record('Jane Doe', aText), B, record('Victor Gluck', bText), dir);
  assert.equal(r.canonical, A, 'the file whose own text carries its byline must win');
});

test('attestation stays silent when neither byline is printed', () => {
  // Falls through to the pre-existing chain rather than inventing a winner.
  const A = 'outlet--aaa-person.json';
  const B = 'outlet--zzz-person.json';
  const text = 'An article with no byline line at all.';
  const r = chooseCanonicalForRebuild(A, record('Aaa Person', text), B, record('Zzz Person', text), '/tmp/x/show');
  assert.ok(r.canonical === A || r.canonical === B);
  assert.doesNotMatch(r.reason, /printed in the article text/);
});

test('(CODEX) a truncated real review is NOT demoted by an editor credit', () => {
  // Codex adversarial review, 2026-09-15. Extraction regularly drops one copy's
  // header while the sibling keeps the full article, and dedupe accepts such
  // truncated subsets as cohesive. Jane Doe is the real critic but her own copy
  // lost its byline line; the sibling carries theaterscene.net's site-wide
  // "by Victor Gluck, Editor-in-Chief" credit. Demoting Jane here would delete a
  // real review from the site. Her name still appears in the fuller copy, so the
  // tiebreak must stay silent.
  const A = 'theater-scene--jane-doe.json';
  const B = 'theater-scene--victor-gluck.json';
  const aText = 'The play opens in a bunker. (truncated — byline header lost)';
  const bText = 'Review by Jane Doe. The play opens in a bunker. Posted by Victor Gluck, Editor-in-Chief.';
  const r = chooseCanonicalForRebuild(A, record('Jane Doe', aText), B, record('Victor Gluck', bText), '/tmp/x/show');
  assert.doesNotMatch(r.reason, /printed in the article text/,
    'must not demote a byline that appears in the sibling copy');
});

test('(CODEX) demotion still fires when the byline is in NEITHER copy', () => {
  // The Safe House shape: "Scott Bennett" appears nowhere in either copy.
  const A = 'theater-scene--victor-gluck.json';
  const B = 'theater-scene--scott-bennett.json';
  const both = 'Posted on September 7, 2026 by Victor Gluck, Editor-in-Chief.';
  const r = chooseCanonicalForRebuild(A, record('Victor Gluck', both), B, record('Scott Bennett', both), '/tmp/x/show');
  assert.equal(r.canonical, A);
  assert.match(r.reason, /printed in the article text/);
});

test('(SHIPCHECK) production credits are not bylines', () => {
  // A bare "by" also introduces every production credit on the page. Without
  // this, a criticName scraper-lifted from "Directed by ..." attests as though
  // it authored the article — and could then demote the real review, whose own
  // byline came from an aggregator listing and is not printed in the body.
  // Verified live: 11 of 130 one-sided attestations in the corpus matched a
  // credits/bio phrase (ship-check, 2026-09-15).
  assert.equal(isBylineAttestedInText('Benjamin Viertel', 'Tightly directed by Benjamin Viertel and making its premiere'), false);
  assert.equal(isBylineAttestedInText('Some Composer', 'with music by Some Composer and lyrics'), false);
  assert.equal(isBylineAttestedInText('Viktorija Mickute', 'Photographs by Viktorija Mickute for the Times'), false);
  assert.equal(isBylineAttestedInText('Viktorija Mickute', '(Photo credit: Viktorija Mickute) The play opens'), false);
});

test('(SHIPCHECK) a real byline still attests alongside credit lines', () => {
  // The discriminator is the token before "by", not the presence of credits.
  const text = 'Directed by Bob Smith. Review by Jane Doe.';
  assert.equal(isBylineAttestedInText('Jane Doe', text), true);
  assert.equal(isBylineAttestedInText('Bob Smith', text), false);
  // "written by" stays a marker — it is a legitimate article byline form.
  assert.equal(isBylineAttestedInText('Enda Walsh', 'A new play. Written by Enda Walsh.'), true);
});
