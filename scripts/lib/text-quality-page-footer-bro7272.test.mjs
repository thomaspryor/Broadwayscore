/**
 * BRO-7272 class guard: a complete review followed by page-footer chrome whose last
 * characters look like a cut-off ("..." teaser, "Like Loading...", stacked ads) must
 * still assess as complete. Fails if the footer anchors in text-quality.js are removed.
 * Synthetic prose only (no review text).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { assessFullText } = require('./text-quality.js');

const BODY = 'The staging is spare and the cast is superb. '.repeat(30) +
  'The final scene lands with real force, and the evening ends on a quiet, devastating note.';

const FOOTERS = {
  nypost: " Read More Filed under broadway plays theater reviews 11/9/26 Read Next 'Another' review: A long teaser headline goes off ...",
  wordpress: ' Share this: Click to share on X (Opens in new window) X Click to email a link to a friend (Opens in new window) Email Print (Opens in new window) Print Like Loading...',
  nytimesRibbon: ' +Give this article+Advertisement',
  stackedAds: ' Advertisement Advertisement Advertisement',
};

for (const [name, footer] of Object.entries(FOOTERS)) {
  test(`complete review + ${name} footer is complete`, () => {
    assert.strictEqual(assessFullText(BODY + footer, true, { trustedComplete: true }), 'complete');
  });
}

test('a genuinely cut-off body still reads truncated', () => {
  const cut = BODY.slice(0, BODY.length - 40) + ' and the evening ends on a qu...';
  assert.strictEqual(assessFullText(cut, true, { trustedComplete: true }), 'truncated');
});
