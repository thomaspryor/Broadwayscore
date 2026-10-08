import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { explainExclusion, isIncludableForRebuild } = require('./review-guards.js');

const text = 'A perfectly ordinary review body with more than enough words to pass the text gate and be scored normally.';

// BRO-4886: Who's Afraid of Virginia Woolf 2020 had 9 previews, then COVID closed it. It carried a score
// from a 2005 review because nothing stopped a never-opened show from counting reviews.
test('a show cancelled before opening excludes every review, whatever the flags say', () => {
  const show = { id: 'woolf-2020', cancelledBeforeOpening: true };
  const review = { fullText: text, url: 'https://example.com/reviews/woolf', criticName: 'A Critic', assignedScore: 87 };
  assert.equal(explainExclusion(review, show, undefined), 'showNeverOpened');
  assert.equal(isIncludableForRebuild(review, show, undefined), false);
  const cleared = { ...review, wrongProductionManualClear: true, wrongProductionOverride: true };
  assert.equal(explainExclusion(cleared, show, undefined), 'showNeverOpened');
});

test('a show that opened is unaffected', () => {
  const review = { fullText: text, url: 'https://example.com/reviews/woolf', criticName: 'A Critic', assignedScore: 87 };
  assert.notEqual(explainExclusion(review, { id: 'woolf-2012' }, undefined), 'showNeverOpened');
  assert.notEqual(explainExclusion(review, { id: 'x', cancelledBeforeOpening: false }, undefined), 'showNeverOpened');
  assert.notEqual(explainExclusion(review, null, undefined), 'showNeverOpened');
});
