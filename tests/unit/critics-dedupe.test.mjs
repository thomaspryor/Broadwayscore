import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { personalRepostParent } = require('../../scripts/lib/personal-repost-sites.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');

test('showriz "My Variety Review" repost resolves to variety (BRO-2403)', () => {
  const d = { url: 'https://showriz.com/blogcategoryreviews/2026/10/1/x', title: "My Variety Review: Broadway's Paranormal Activity" };
  assert.strictEqual(personalRepostParent(d), 'variety');
});
test('showriz original take stays independent', () => {
  const d = { url: 'https://www.showriz.com/blogcategoryreviews/2026/7/20/my-own-take-off-broadways-an-american-daughter', title: "My Own Take: Off-Broadway's An American Daughter" };
  assert.strictEqual(personalRepostParent(d), null);
});
test('Variety itself and manual clear are not affected', () => {
  assert.strictEqual(personalRepostParent({ url: 'https://variety.com/x', title: 'My Variety Review' }), null);
  assert.strictEqual(personalRepostParent({ url: 'https://showriz.com/a', title: 'My Variety Review', personalRepostCleared: true }), null);
});
test('explainExclusion excludes the repost as personalRepost', () => {
  const d = { showId: 's', outlet: 'Showriz', url: 'https://showriz.com/a', title: 'My Variety Review: X', fullText: 'x '.repeat(400) };
  assert.strictEqual(explainExclusion(d, { id: 's' }, '/tmp/x.json'), 'personalRepost');
});
