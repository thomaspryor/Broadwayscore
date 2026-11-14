import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpResultMentionsShow } = require('../../scripts/lib/serp-show-match.js');
const { londonAggregatorCandidates } = require('../../scripts/lib/other-production-signal.js');
const { wetArchiveProblem } = require('../../scripts/lib/wet-archive-guard.js');

test('The Verge publisher branding does not queue tech reviews for the play', () => {
  // URLs recorded in the opening-night press audit. Headlines exercise the
  // publisher suffix, which is not evidence that the article names the play.
  const cases = [
    ['MacBook Pro display review | The Verge', 'https://www.theverge.com/tech/1026570/apple-macbook-pro-proled-xdr-display-review'],
    ['iMac review - The Verge', 'https://www.theverge.com/tech/1027177/2026-imac-m6-review'],
    ['Headphones review \u2013 The Verge', 'https://www.theverge.com/tech/1026958/sony-mdr-3r-headphones-review'],
    ['Camera review \u2014 The Verge', 'https://www.theverge.com/tech/1027575/camp-snap-cs-8-mini-retro-film-camera-kid-friendly'],
    ['The Verge', 'https://www.theverge.com/tech/1027250/m6-macbook-pro-review'],
  ];
  for (const [title, url] of cases) {
    assert.equal(serpResultMentionsShow(title, url, 'The Verge'), false, title);
  }
});

test('headlines and article paths naming the play still queue genuine reviews', () => {
  const cases = [
    ['The Verge: A Portrait in Discontent', 'https://nystagereview.com/2026/11/05/the-verge-a-portrait-in-discontent/'],
    ['Review: The Verge at the Public Theater', 'https://exeuntnyc.com/reviews/review-the-verge-at-the-public-theater/'],
    ['The Verge review | The Verge', 'https://www.theverge.com/culture/a-theatre-review'],
    ['Theatre review | The Verge', 'https://www.theverge.com/culture/the-verge-review'],
    ['The Verge review', 'https://example.com/content/123'],
  ];
  for (const [title, url] of cases) {
    assert.equal(serpResultMentionsShow(title, url, 'The Verge'), true, title);
  }
  assert.equal(serpResultMentionsShow('iMac review | The Verge', 'https://www.theverge.com/tech/imac-review', 'iMac'), true);
});

test('London prior-production roundups cannot be filed under off-Broadway The Unbelievers', () => {
  const nyc = { id: 'the-unbelievers-off-broadway-2026', title: 'The Unbelievers', category: 'off-broadway', openingDate: '2026-11-05' };
  const london = { id: 'the-unbelievers-west-end-2025', title: 'The Unbelievers', category: 'west-end', openingDate: '2025-10-16' };
  const post = { postDate: '2025-10-21' };
  assert.deepEqual(londonAggregatorCandidates([nyc, london]), [london]);
  assert.deepEqual(londonAggregatorCandidates([nyc]), []);
  assert.equal(wetArchiveProblem(nyc, post).code, 'non-london-show');
  assert.equal(wetArchiveProblem(london, post), null);
});
