import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectCrossShowUrlMismatch, buildShowSlugIndex } = require('./cross-show-url.js');

// Synthetic index so the test runs without data/shows.json (worktree + CI safe).
const SHOWS = [
  { id: 'schmigadoon-2026', title: 'Schmigadoon!' },
  { id: 'every-brilliant-thing-2026', title: 'Every Brilliant Thing' },
  { id: 'care-west-end-2026', title: 'Care' },
  { id: 'the-cherry-orchard-2026', title: 'The Cherry Orchard' },
  { id: 'romeo-and-juliet-west-end-2026', title: 'Romeo and Juliet' },
  { id: 'romeo-juliet-2024', title: 'Romeo + Juliet' },
  { id: 'kinky-boots-2013', title: 'Kinky Boots' },
  { id: 'kinky-boots-the-musical-west-end-2015', title: 'Kinky Boots the Musical' },
];
const index = buildShowSlugIndex(SHOWS);

function check(showId, url) {
  return detectCrossShowUrlMismatch(showId, url, { index });
}

test('flags Every Brilliant Thing URL filed under Schmigadoon (the 2026-06 incident)', () => {
  const r = check('schmigadoon-2026', 'https://www.nytimes.com/2026/03/12/theater/every-brilliant-thing-review-daniel-radcliffe.html');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'every-brilliant-thing-2026');
});

test('leaves a genuine Schmigadoon review alone', () => {
  assert.equal(check('schmigadoon-2026', 'https://variety.com/2026/legit/reviews/schmigadoon-broadway-review-1236685975/'), null);
});

test('does not flag same-play different-production (connector-normalized)', () => {
  // romeo-and-juliet vs romeo + juliet — same play, must not cross-flag
  assert.equal(check('romeo-and-juliet-west-end-2026', 'https://www.nytimes.com/2024/03/01/theater/romeo-and-juliet-review.html'), null);
  assert.equal(check('romeo-juliet-2024', 'https://www.timeout.com/newyork/theater/romeo-and-juliet-review'), null);
});

test('does not flag prefix-related titles (Kinky Boots vs Kinky Boots the Musical)', () => {
  assert.equal(check('kinky-boots-2013', 'https://example.com/reviews/kinky-boots-the-musical-review'), null);
});

test('does not flag on common URL-path stopwords', () => {
  // "/broadway/" appears in ~most review URLs; "broadway" is excluded from the index.
  assert.equal(check('schmigadoon-2026', 'https://www.nytimes.com/2026/04/20/theater/broadway/schmigadoon-review.html'), null);
});

test('returns null when the filed show has a sub-8-char title (documented short-title limitation)', () => {
  // "Care" -> slug "care" (4 chars) is below the index threshold, so the guard
  // cannot evaluate it. This is why Care's Equus/Cherry-Orchard contaminants
  // were NOT caught by the URL guard and needed manual flagging.
  assert.equal(check('care-west-end-2026', 'https://www.londontheatre.co.uk/reviews/equus-review-menier'), null);
});

test('flags when URL clearly names a different distinctive show', () => {
  const r = check('schmigadoon-2026', 'https://exeuntnyc.com/reviews/review-every-brilliant-thing-at-the-hudson-theatre/');
  assert.ok(r);
  assert.equal(r.matchedShowId, 'every-brilliant-thing-2026');
});
