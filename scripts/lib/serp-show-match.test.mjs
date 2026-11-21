import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpResultMentionsShow } = require('./serp-show-match.js');

// Regression: Encores! series prefix. Critics title these by the work, not the
// series, so "La Cage aux Folles at Encores!" must still match the show whose
// canonical title is "Encores! La Cage Aux Folles". This was silently dropping
// every legit Encores review from SERP discovery (amNewYork, etc., 2026-06-21).
test('Encores! prefix — headline naming the work matches', () => {
  const showTitle = 'Encores! La Cage Aux Folles';
  assert.equal(
    serpResultMentionsShow(
      "Review | 'La Cage aux Folles' at Encores! has ambition but rough execution",
      'https://www.amny.com/news/review-la-cage-aux-folles-at-encores/',
      showTitle,
    ),
    true,
  );
  assert.equal(
    serpResultMentionsShow(
      'A Breathtaking Billy Porter In an Unfortunately Un-Glam LA CAGE AUX FOLLES — Review',
      'https://www.theatrely.com/post/...-un-glam-la-cage-aux-folles-review',
      showTitle,
    ),
    true,
  );
});

test('Encores! prefix — unrelated headline still rejected', () => {
  const showTitle = 'Encores! La Cage Aux Folles';
  assert.equal(
    serpResultMentionsShow(
      'Review: Paddington The Musical bound for Broadway',
      'https://www.amny.com/news/paddington-musical-broadway/',
      showTitle,
    ),
    false,
  );
});

test('Off-Center variant prefix is stripped too', () => {
  assert.equal(
    serpResultMentionsShow(
      'Review: Titanic at Encores! Off-Center',
      'https://example.com/titanic-review/',
      'Encores! Off-Center Titanic',
    ),
    true,
  );
});

// Guard: titles whose own name contains "!" must NOT be truncated to a generic
// core. "Moulin Rouge! The Musical" must not start matching on the word "musical".
test('non-series "!" titles are not over-stripped', () => {
  assert.equal(
    serpResultMentionsShow(
      'Review: Some Other Musical opens downtown',
      'https://example.com/some-other-musical/',
      'Moulin Rouge! The Musical',
    ),
    false,
  );
  assert.equal(
    serpResultMentionsShow(
      'Oklahoma! revival dazzles',
      'https://example.com/oklahoma-revival/',
      'Oklahoma!',
    ),
    true,
  );
});

// Existing behavior preserved: colon-split and plain titles still match.
test('colon-split primary title still matches', () => {
  assert.equal(
    serpResultMentionsShow(
      'CATS: The Jellicle Ball review',
      'https://example.com/cats-jellicle-ball/',
      'CATS: The Jellicle Ball',
    ),
    true,
  );
});
