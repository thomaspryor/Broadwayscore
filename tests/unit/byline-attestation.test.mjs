/**
 * Regression test (BRO-3247, 2026-09-15): same-URL byline dedup crowned a
 * scraper-invented byline over the real one.
 *
 * Live failure: Safe House (off-Broadway, Theatre Row) had two review-text
 * files for ONE theaterscene.net URL — "Victor Gluck" (the real byline, printed
 * in the article as "Posted on September 7, 2026 by Victor Gluck,
 * Editor-in-Chief") and "Scott Bennett" (a name appearing nowhere in the
 * article). Both were includable, both scored, same publishDate — so every
 * tiebreak in chooseCanonical tied and the final ALPHABETICAL FILENAME tiebreak
 * picked "scott-bennett" over "victor-gluck". The automated dedup then wrote
 * duplicateOf onto the REAL review, suppressing it and keeping the phantom.
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

// The two bylines exactly as they appeared, with the article's real byline line.
const ARTICLE = `Safe House A gripping and tense state-of-the-nation drama that is one of the
best plays of the year. Posted on September 7, 2026 by Victor Gluck, Editor-in-Chief in
Off-Broadway , Plays , Still Open. Karen Ziemba as Slipper and Marc Kudisch as Rock in a
scene from L.B. Browne's "Safe House" at Theatre Four on Theatre Row.`;

test('the printed byline is attested, the invented one is not', () => {
  assert.equal(isBylineAttestedInText('Victor Gluck', ARTICLE), true);
  assert.equal(isBylineAttestedInText('Scott Bennett', ARTICLE), false);
});

test('single-token bylines never count as attested (too weak a signal)', () => {
  // "Ross" is a real frontmezzjunkies byline; one common word proves nothing,
  // so it must return false even when the word is present in the text.
  assert.equal(isBylineAttestedInText('Ross', 'the ross family bunker'), false);
});

test('attestation ignores accents and apostrophes', () => {
  // \b-style word boundaries break on exactly these characters —
  // memory/feedback_word_boundary_punct_titles.md.
  assert.equal(isBylineAttestedInText("Maureen O'Hara", 'by Maureen OHara'), true);
  assert.equal(isBylineAttestedInText('Beatrice Onions', 'by Beatrice Oñions'), true);
  assert.equal(isBylineAttestedInText('Jose Rivera', 'reviewed by José  Rivera.'), true);
});

test('name tokens must be adjacent, not merely both present', () => {
  assert.equal(
    isBylineAttestedInText('David Spencer', 'David went to the show; Spencer did not.'),
    false,
  );
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
  const aData = record('Victor Gluck', ARTICLE);
  const bData = record('Scott Bennett', ARTICLE);
  const dir = '/tmp/nonexistent-show-dir/safe-house-off-broadway-2026';

  // Alphabetically "scott-bennett" < "victor-gluck", so the pre-fix filename
  // tiebreak returned B here. Both argument orders must now return A.
  const forward = chooseCanonicalForRebuild(A, aData, B, bData, dir);
  const reverse = chooseCanonicalForRebuild(B, bData, A, aData, dir);

  assert.equal(forward.canonical, A, 'forward order must keep the real byline');
  assert.equal(reverse.canonical, A, 'reverse order must keep the real byline');
  assert.equal(forward.loser, B);
  assert.equal(reverse.loser, B);
  assert.match(forward.reason, /printed in the article text/);
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
