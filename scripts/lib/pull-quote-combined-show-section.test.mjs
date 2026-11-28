// BRO-7977: a quote on a joint multi-show column must name THIS show (synthetic text; real text is private).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { combinedColumnQuoteLacksOwnShow } = require('./pull-quote-guards.js');

const sweat = {
  title: 'Sweat',
  cast: [{ name: 'Johanna Day' }, { name: 'Alison Wright' }],
  creativeTeam: [{ name: 'Lynn Nottage', role: 'Playwright' }, { name: 'Kate Whoriskey', role: 'Director' }],
};
const joint = { isCombinedReview: true, combinedWith: ['the-play-that-goes-wrong-2017'], multiShowSplitAnchorKind: 'joint', multiShowSplitParent: true };

test('rejects the sibling show sentence that shipped on sweat-2017', () => {
  assert.equal(combinedColumnQuoteLacksOwnShow('Jones turns Yank\'s journey into a road trip to hell, creating one amazing encounter after another.', joint, sweat), true);
});
test('rejects a sentence that only mentions this title in passing', () => {
  assert.equal(combinedColumnQuoteLacksOwnShow('The Play That Goes Wrong is marvelously right, a break from the onslaught predicted by Sweat and Hairy Ape.', joint, sweat), true);
});
test('keeps a sentence naming this show\'s playwright or cast', () => {
  assert.equal(combinedColumnQuoteLacksOwnShow('Nottage’s slice-of-lifer is moving and impactful.', joint, sweat), false);
  assert.equal(combinedColumnQuoteLacksOwnShow('Kudos to Johanna Day’s flinty Tracey.', joint, sweat), false);
});
test('does not touch single-show or already-split reviews', () => {
  const q = 'Jones turns Yank\'s journey into a road trip to hell.';
  assert.equal(combinedColumnQuoteLacksOwnShow(q, { ...joint, isCombinedReview: false }, sweat), false);
  assert.equal(combinedColumnQuoteLacksOwnShow(q, { ...joint, multiShowSplitAnchorKind: 'header' }, sweat), false);
  assert.equal(combinedColumnQuoteLacksOwnShow(q, { ...joint, multiShowSplitAnchorKind: undefined }, sweat), false);
});
test('a split child copy (own section only) and a short title with no cast are left alone', () => {
  assert.equal(combinedColumnQuoteLacksOwnShow('A gripping, urgent drama.', { ...joint, multiShowSplitParent: undefined }, sweat), false);
  assert.equal(combinedColumnQuoteLacksOwnShow('Hir is a fierce triumph.', joint, { title: 'Hir' }), false);
});
test('a lowercase-start (soft-deferred) sibling fragment is rejected too', () => {
  const { selectBestExcerpt } = require('../rebuild-all-reviews.js');
  const q = selectBestExcerpt({ showId: 'sweat-2017', outletId: 'theater-life', ...joint, showScoreExcerpt: '\u201cjones turns the journey into a vivid road trip to hell, creating one amazing encounter.' }, 'Sweat');
  assert.ok(!/road trip to hell/.test(q || ''), q);
});
test('rebuild cascade drops the sibling quote and falls to this show\'s own excerpt', () => {
  const { selectBestExcerpt } = require('../rebuild-all-reviews.js');
  const own = 'Nottage’s slice-of-lifer is moving and impactful even if the plot is somewhat melodramatic, thanks to Whoriskey’s detailed direction.';
  const base = { showId: 'sweat-2017', outletId: 'theater-life', ...joint, llmScore: { score: 76, keyPhrases: [{ quote: 'Jones turns Yank\'s journey into a road trip to hell, creating one amazing encounter after another.' }] } };
  const q = selectBestExcerpt({ ...base, showScoreExcerpt: own }, 'Sweat');
  assert.ok(!/road trip to hell/.test(q || ''), q);
});
