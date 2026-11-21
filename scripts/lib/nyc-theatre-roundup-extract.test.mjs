/**
 * BRO-7100: NYC Theatre roundup extraction regressions. Synthetic HTML in the
 * shape of the archived the-last-five-years-2025 page (no review text).
 * Per CLAUDE.md rule 15 this require()s the real extractor and junk guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractReviewsFromRoundup } = require('../scrape-nyc-theatre-roundups.js');
const { isJunkOutlet } = require('./review-normalization.js');

const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

test('isJunkOutlet rejects section headings and modal-verb fragments', () => {
  for (const s of ['Reviews', 'The Reviews', 'Critics', 'should appeal to two audiences', 'Tickets available from the theatre']) {
    assert.equal(isJunkOutlet(s), true, s);
  }
  // 'review' is a registered alias of reviewing-the-drama, so it must stay valid.
  for (const s of ['TheatreMania', 'New York Theatre Guide', 'Amny', 'Culturesauce', 'review', 'Reviewing the Drama', 'Ticket Holders LA']) {
    assert.equal(isJunkOutlet(s), false, s);
  }
});

const PAGE = `<html><body>
<h2>See what critics had to say about the show</h2>
<p>Intro paragraph about the production and its cast.</p>
<h4>Reviews</h4>
<p>"A synthetic quote that is long enough to count as an excerpt." TheatreMania</p>
<p>"Another synthetic quote that is long enough to count here." New York Theatre Guide</p>
<p>"A third synthetic quote long enough to be kept as excerpt." Amny</p>
<p>"A fourth synthetic quote long enough to be kept as excerpt." Culturesauce</p>
<h3>What Is The Story?</h3>
<p>Plot summary text that should never be read as a review excerpt at all.</p>
</body></html>`;

test('a generic <h4>Reviews</h4> heading is not an outlet; dash-less attributions parse', () => {
  const reviews = quiet(() => extractReviewsFromRoundup(PAGE, 'synthetic-show'));
  const outlets = reviews.map(r => r.outlet);
  assert.ok(!outlets.some(o => /^reviews$/i.test(o)), JSON.stringify(outlets));
  assert.deepEqual(outlets, ['TheatreMania', 'New York Theatre Guide', 'Amny', 'Culturesauce']);
  assert.equal(reviews[0].excerpt, 'A synthetic quote that is long enough to count as an excerpt.');
});

test('dash attributions still strip the outlet from the excerpt', () => {
  const html = '<p>"A synthetic quote that is long enough to count as an excerpt." - Variety</p>';
  const reviews = quiet(() => extractReviewsFromRoundup(html, 'synthetic-show'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].outlet, 'Variety');
  assert.equal(reviews[0].excerpt, 'A synthetic quote that is long enough to count as an excerpt.');
});
