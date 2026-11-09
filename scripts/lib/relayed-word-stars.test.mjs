// BRO-6905: news roundups relay OTHER critics' stars ("The Guardian gave the
// play four out of five stars"). The spelled-out star extractor stored those
// as the article's own rating (PA syndications of the Game of Thrones: The Mad
// King roundup, Metro's Romeo and Juliet roundup: 5/5 word-stars). Synthetic
// text in the same shape; no review text is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore, extractGenericStarRating, extractUKStarRating, isRelayedStarRating } = require('./score-extractors.js');

const filler = 'The staging is busy and the cast work hard across a long evening of scenes. '.repeat(6);
const at = (text, phrase) => text.indexOf(phrase);

test('a roundup that relays other critics\' word-stars yields no rating', () => {
  const text = `Some Show has been praised in near-universally positive reviews.\n\n${filler}\n\n`
    + 'The Telegraph awarded the production four out of five stars, calling it a spectacle.\n\n'
    + `${filler}\n\nThe Guardian gave the play four out of five stars.\n\n${filler}\n\n`
    + 'Meanwhile, the Telegraph’s critic gave the production a full five stars.';
  assert.equal(extractGenericStarRating(text, text), null);
  assert.equal(extractUKStarRating(text, text), null);
  assert.equal(extractScore(text, text, 'theargus', 'Some Show'), null);
  assert.equal(extractScore(text, text, 'metro-uk', 'Some Show'), null);
});

test('the critic\'s own spelled-out verdict is still read', () => {
  const own = `${filler}\n\nFour out of five stars.`;
  assert.equal(extractGenericStarRating(own, own).originalScore, '4/5 stars');
  const firstPerson = `${filler}\n\nI'd give it four stars.`;
  assert.equal(extractGenericStarRating(firstPerson, firstPerson).originalScore, '4/5 stars');
  // Capitalised "Awards" is a noun, not a giving verb (digital-journal shape).
  const award = `${filler} It deserves recognition at the upcoming Tony Awards, and it garners four out of five stars.`;
  assert.equal(extractGenericStarRating(award, award).originalScore, '4/5 stars');
});

test('a relayed star is skipped but a later own verdict is kept', () => {
  const text = `${filler} The Guardian gave it two stars. ${filler} Verdict: Four stars.`;
  assert.equal(extractGenericStarRating(text, text).originalScore, '4/5 stars');
});

test('isRelayedStarRating reads only the match\'s own sentence', () => {
  const t = 'The Times gave it a rave. Three stars.';
  assert.equal(isRelayedStarRating(t, at(t, 'Three')), false);
  const r = 'Writing for the Daily Mail, critic Patrick Marmion gave the production four out of five stars.';
  assert.equal(isRelayedStarRating(r, at(r, 'four')), true);
  const s = 'Awarding the show three stars, the critic praised the lead.';
  assert.equal(isRelayedStarRating(s, at(s, 'three')), true);
});
