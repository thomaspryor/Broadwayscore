import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { explainExclusion, isIncludableForRebuild, isShowNeverOpened } = require('./review-guards.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const text = 'A perfectly ordinary review body with more than enough words to pass the text gate and be scored normally.';
const review = { fullText: text, url: 'https://example.com/reviews/woolf', criticName: 'A Critic', assignedScore: 87 };

// BRO-4886: Who's Afraid of Virginia Woolf 2020 had 9 previews, then COVID closed it. It carried a score
// from a 2005 review because nothing stopped a never-opened show from counting reviews.
test('predicate: only an explicit cancelledBeforeOpening show is never-opened', () => {
  assert.equal(isShowNeverOpened({ id: 'woolf-2020', cancelledBeforeOpening: true }), true);
  assert.equal(isShowNeverOpened({ id: 'woolf-2012' }), false);
  assert.equal(isShowNeverOpened({ id: 'x', cancelledBeforeOpening: false }), false);
  assert.equal(isShowNeverOpened({ id: 'x', status: 'announced' }), false, 'an announced show is not a cancelled one');
  assert.equal(isShowNeverOpened(null), false);
});

test('a show cancelled before opening excludes every review, whatever the flags say', () => {
  const show = { id: 'woolf-2020', cancelledBeforeOpening: true };
  assert.equal(explainExclusion(review, show, undefined), 'showNeverOpened');
  assert.equal(isIncludableForRebuild(review, show, undefined), false);
  const cleared = { ...review, wrongProductionManualClear: true, wrongProductionOverride: true };
  assert.equal(explainExclusion(cleared, show, undefined), 'showNeverOpened');
});

test('a show that opened is unaffected', () => {
  assert.notEqual(explainExclusion(review, { id: 'woolf-2012' }, undefined), 'showNeverOpened');
  assert.notEqual(explainExclusion(review, { id: 'x', cancelledBeforeOpening: false }, undefined), 'showNeverOpened');
  assert.notEqual(explainExclusion(review, null, undefined), 'showNeverOpened');
});

// rebuild-all-reviews.js does not delegate to explainExclusion (BRO-4101 lesson), so the rule only reaches
// reviews.json if the loop calls the predicate itself.
test('rebuild-all-reviews.js enforces the predicate in its main loop, before the later flag-writing branches', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /if \(isShowNeverOpened\(showById\[showId\]\)\) \{\s*logExclusion\("skippedShowNeverOpened"/);
  assert.ok(
    src.indexOf('isShowNeverOpened(showById[showId])') < src.indexOf('logExclusion("skippedNonReview"'),
    'must run before the later branches that write flags back to disk',
  );
});
