import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { urlLooksLikeReview } = require('./review-guards');
const { hasSubtitleTail } = require('./title-normalization');

// BRO-3711: "America, Who Hurt You?" collapsed to "America" and matched the Marvel film.
const FILM = [
  'https://nypost.com/2025/02/12/entertainment/captain-america-brave-new-world-review-sorry-marvel-is-still-terrible/',
  'https://www.thewrap.com/captain-america-brave-new-world-review/',
];

test('clause-tail comma titles do not collapse to the head word', () => {
  for (const u of FILM) assert.equal(urlLooksLikeReview(u, 'America, Who Hurt You?'), false, u);
  assert.equal(hasSubtitleTail('America, Who Hurt You?'), false);
  assert.equal(hasSubtitleTail('Girl, Interrupted'), false);
});

test('article-led subtitles still use the short title (Beaches regression)', () => {
  assert.equal(hasSubtitleTail('Beaches, A New Musical'), true);
  assert.equal(hasSubtitleTail('A Beautiful Noise, The Neil Diamond Musical'), true);
  assert.equal(urlLooksLikeReview('https://www.nytimes.com/2026/04/22/theater/beaches-review-broadway.html', 'Beaches, A New Musical'), true);
});

test('real review of the clause-tail show still matches via full title words', () => {
  assert.equal(urlLooksLikeReview('https://www.nytimes.com/2026/09/20/theater/america-who-hurt-you-review.html', 'America, Who Hurt You?'), true);
});
