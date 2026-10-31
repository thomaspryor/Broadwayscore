// BRO-4267 — School Girls opening night, 2026-09-28. The "Mean Girls" show's slug sits
// INSIDE this show's slug, and outlets drop the "or the" connectors from their URL slugs,
// so detectCrossShowUrlMismatch() rejected the show's own Guardian, Culture Sauce and
// Chicago Tribune reviews as belonging to "Mean Girls". The fix: connector-normalize the
// slug (and/the/or), and when another show's title is contained in this one, only call a
// URL cross-show if it carries none of this show's own distinctive tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectCrossShowUrlMismatch, buildShowSlugIndex } = require('./cross-show-url.js');

// Synthetic index so the test runs without data/shows.json (worktree + CI safe).
const SHOWS = [
  { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play' },
  { id: 'mean-girls-2018', title: 'Mean Girls' },
  { id: 'schmigadoon-2026', title: 'Schmigadoon!' },
  { id: 'every-brilliant-thing-2026', title: 'Every Brilliant Thing' },
];
const index = buildShowSlugIndex(SHOWS);
const SG = 'school-girls-or-the-african-mean-girls-play-2026';
const check = (showId, url) => detectCrossShowUrlMismatch(showId, url, { index });

test('own reviews whose slug drops the connectors are not cross-show (Culture Sauce, Chicago Tribune)', () => {
  assert.equal(check(SG, 'https://culturesauce.com/school-girls-african-mean-girls-play-broadway-review/'), null);
  assert.equal(check(SG, 'https://www.chicagotribune.com/2026/09/28/review-school-girls-african-mean-girls-broadway/'), null);
});

test('own review whose slug keeps only a distinctive token is not cross-show (Guardian)', () => {
  assert.equal(check(SG, 'https://www.theguardian.com/stage/2026/sep/28/school-african-mean-girls-play-review'), null);
});

test('a genuine Mean Girls URL filed under School Girls is still a mismatch', () => {
  const r = check(SG, 'https://www.thewrap.com/renee-rapp-mean-girls-2024-review/');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'mean-girls-2018');
  const r2 = check(SG, 'https://www.nytimes.com/2018/04/08/theater/mean-girls-review-broadway.html');
  assert.ok(r2, 'expected a mismatch');
  assert.equal(r2.matchedShowId, 'mean-girls-2018');
});

test('generic tokens (play, broadway, review) never vouch for the containing show', () => {
  const r = check(SG, 'https://example.com/theater/mean-girls-play-review-broadway/');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'mean-girls-2018');
});

test('a single shared-sounding word does not vouch: a Mean Girls URL that says "high-school" is still a mismatch', () => {
  const r = check(SG, 'https://example.com/reviews/mean-girls-high-school-satire-review/');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'mean-girls-2018');
});

test('own review that keeps only the subtitle phrase is not cross-show (one word, but next to the contained title)', () => {
  assert.equal(check(SG, 'https://example.com/theater/the-african-mean-girls-play-is-sharp-and-funny/'), null);
  assert.equal(check(SG, 'https://example.com/reviews/african-mean-girls-play-review-broadway/'), null);
});

test('a word next to the contained title in the URL but not in this show\'s slug does not vouch alone', () => {
  const r = check(SG, 'https://example.com/reviews/mean-girls-school-edition-review/');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'mean-girls-2018');
});

test('vouching words match whole path words only (preschool is not school)', () => {
  const r = check(SG, 'https://example.com/reviews/mean-girls-review-preschool-african-american-cast/');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'mean-girls-2018');
});

test('the containment carve-out does not weaken unrelated mismatches', () => {
  const r = check('schmigadoon-2026', 'https://www.nytimes.com/2026/03/12/theater/every-brilliant-thing-review-daniel-radcliffe.html');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'every-brilliant-thing-2026');
});
