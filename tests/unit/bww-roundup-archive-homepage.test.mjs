/**
 * Regression test for BRO-723: BWW roundup archive saved the BWW homepage
 * for unopened shows.
 *
 * scrape-bww-reviews.js:451 (pre-fix) validated fetched HTML with
 * `html.includes('critics') || html.includes('Review Roundup')`. The BWW
 * homepage contains both strings in its nav/sidebar teaser links, so an
 * unopened show's roundup fetch (which 404s to the homepage) passed
 * validation and got archived as data/aggregator-archive/bww-roundups/{id}.html.
 *
 * Fixed 2026-04-07 (commit e1060d7a) by extracting isBWWRoundupContent() to
 * scripts/lib/bww-roundup-validator.js and using it at every fetch-then-archive
 * call site in both scrape-bww-reviews.js and gather-reviews.js. This test
 * requires the real shared function (not a reimplementation) so a future
 * loosening of the check fails here first.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isBWWRoundupContent } = require('../../scripts/lib/bww-roundup-validator.js');

// Trimmed real-shape BWW homepage: nav/sidebar teaser links mention "critics"
// and "Review Roundup" for OTHER shows' roundups, but the page itself has no
// article markup and no "Review Roundup" in <title> — exactly what an
// unopened show's roundup URL 404-redirects to.
const BWW_HOMEPAGE_HTML = `
<!DOCTYPE html>
<html>
<head><title>BroadwayWorld: Off-Broadway, Broadway, Regional &amp; West End News, Coverage, Tickets, Reviews &amp; More!</title></head>
<body>
  <nav>
    <a href="/article/Review-Roundup-SOME-OTHER-SHOW-20260401">Review Roundup: What did the critics say?</a>
    <a href="/reviews/">Reviews</a>
  </nav>
  <div class="teaser-list">
    <div class="teaser">See what the critics are saying in our latest Review Roundup coverage.</div>
    <div class="teaser">More critics weigh in on this week's openings.</div>
  </div>
</body>
</html>`.repeat(3); // realistic homepage size, >5000 chars

// Real-shape roundup article: schema.org markup + title tag carries "Review Roundup".
const BWW_ROUNDUP_HTML = `
<!DOCTYPE html>
<html>
<head><title>Review Roundup: HAMILTON Opens on Broadway</title></head>
<body>
  <script type="application/ld+json">{"@type":"BlogPosting","articleBody":"The critics have weighed in..."}</script>
  <div class="article-body">
    <p>Photo Credit: Joan Marcus</p>
    <p>Ben Brantley, New York Times: A triumph.</p>
  </div>
</body>
</html>`;

describe('isBWWRoundupContent — BRO-723 homepage-vs-roundup regression', () => {
  test('rejects the BWW homepage even though it contains "critics" and "Review Roundup"', () => {
    assert.ok(BWW_HOMEPAGE_HTML.includes('critics'), 'precondition: homepage fixture contains "critics"');
    assert.ok(BWW_HOMEPAGE_HTML.includes('Review Roundup'), 'precondition: homepage fixture contains "Review Roundup"');
    assert.strictEqual(isBWWRoundupContent(BWW_HOMEPAGE_HTML), false,
      'the pre-fix loose check (includes critics || includes Review Roundup) would have accepted this homepage');
  });

  test('accepts a real roundup article', () => {
    assert.strictEqual(isBWWRoundupContent(BWW_ROUNDUP_HTML), true);
  });

  test('rejects an empty/short 404 page', () => {
    assert.strictEqual(isBWWRoundupContent(''), false);
    assert.strictEqual(isBWWRoundupContent('<html><body>Page not found</body></html>'), false);
  });

  test('rejects homepage-shaped HTML even when title happens to include "BroadwayWorld:" and body is large', () => {
    const largeHomepage = BWW_HOMEPAGE_HTML.repeat(5);
    assert.ok(largeHomepage.length > 5000, 'precondition: large enough to hit the length-only fallback if title check were skipped');
    assert.strictEqual(isBWWRoundupContent(largeHomepage), false);
  });
});
