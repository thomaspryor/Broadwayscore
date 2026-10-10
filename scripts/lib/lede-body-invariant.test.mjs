import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findLedeBodyViolations } = require('./lede-body-invariant.js');

test('lede ⊆ body: passes when the show is linked in the body (showLink href)', () => {
  const ledeShows = [{ id: 'fear-of-13', slug: 'fear-of-13', title: 'The Fear of 13' }];
  const body = '<a href="https://broadwayscorecard.com/show/fear-of-13">The Fear of 13</a>';
  assert.deepEqual(findLedeBodyViolations(ledeShows, body), []);
});

test('lede ⊆ body: passes when the show is only text-mentioned (no link)', () => {
  const ledeShows = [{ id: 'oh-mary', slug: 'oh-mary', title: 'Oh, Mary!' }];
  const body = '<div>Recouped: Oh, Mary!</div>';
  assert.deepEqual(findLedeBodyViolations(ledeShows, body), []);
});

test('lede ⊆ body: SYNTHETIC VIOLATION — lede names a show absent from the body (2026-07-12 Fear of 13 class)', () => {
  const ledeShows = [{ id: 'fear-of-13', slug: 'fear-of-13', title: 'The Fear of 13' }];
  const body = '<div>Some other show entirely, nothing to do with the lede.</div>';
  const violations = findLedeBodyViolations(ledeShows, body);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /The Fear of 13/);
});

test('lede ⊆ body: SYNTHETIC VIOLATION — edition-mismatched recoupment (2026-07-26 Oh Mary class)', () => {
  // West End edition: the recoupment section never renders, so a slug/title
  // that only shows up in a Broadway-only card is absent from THIS body.
  const ledeShows = [{ id: 'oh-mary', slug: 'oh-mary', title: 'Oh, Mary!' }];
  const body = '<div>West End openings this week: Jesus Christ Superstar.</div>';
  const violations = findLedeBodyViolations(ledeShows, body);
  assert.equal(violations.length, 1);
});

test('lede ⊆ body: no violations when ledeShows is empty or missing', () => {
  assert.deepEqual(findLedeBodyViolations([], '<div>anything</div>'), []);
  assert.deepEqual(findLedeBodyViolations(undefined, '<div>anything</div>'), []);
});

test('lede ⊆ body: skips entries with neither slug nor title (never reports a phantom violation)', () => {
  assert.deepEqual(findLedeBodyViolations([{ id: 'x' }], '<div>irrelevant</div>'), []);
});
