/**
 * BRO-4956: Best of Theatre round-ups as a WE gap-audit reference source.
 * Fixtures are trimmed copies of the live markup (Rent, An Oak Tree, Oct 2026).
 *
 * Run: node --test tests/unit/bestoftheatre-roundup-discover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  discoverBestOfTheatreRoundup, extractBestOfTheatreRows, roundupEntries, slugMatchesShow,
} = require('../../scripts/lib/bestoftheatre-roundup-discover.js');
const { getWeReferenceRows } = require('../../scripts/lib/gap-reference-sources.js');

const PAGE = `<html><head><title>Review Roundup: AN OAK TREE at The Other Palace - Best of Theatre News</title>
<meta property="article:published_time" content="2026-10-09T14:18:00+01:00"></head><body>
<div class="review">
<div class="rhead"><h4>LondonTheatre1</h4>
<span class="stars"><span><span style="width: calc(4 * 20%);"></span></span></span></div>
<p class="by">Reviewer: Chris Omaweng</p>
<p><a class="more" href="https://www.londontheatre1.com/reviews/an-oak-tree-at-the-other-palace/" title="r">Read</a></p>
</div>
<div class="review">
<div class="rhead"><h4>The Spy in the Stalls</h4>
<span class="stars"><span><span style="width: calc(3.5 * 20%);"></span></span></span></div>
<p class="by">Reviewer: Giles Broadbent</p>
<p><a class="more" href="https://thespyinthestalls.com/2026/10/an-oak-tree/">Read</a></p>
</div>
<div class="review">
<div class="rhead"><h4>London Theatre Reviews</h4></div>
<p><a class="more" href="https://www.londontheatrereviews.co.uk/post.cfm?p=29317">Read</a></p>
</div>
<p><strong>Also reviewed by:</strong> <a href="https://www.thestage.co.uk/reviews/an-oak-tree-review-the-other-palace-tim-crouch-gwyneth-keyworth" title="the stage review" target="_blank" rel="nofollow">The Stage</a> (Dave Fargnoli, four stars, "Tim Crouch puts another batch of guest stars through the wringer"), whose review sits behind a registration wall.</p>
</body></html>`;

const SITEMAP = `<urlset>
<url><loc>https://www.bestoftheatre.co.uk/blog/post/review-roundup-an-oak-tree-the-other-palace</loc><lastmod>2026-10-09T14:18:00+01:00</lastmod></url>
<url><loc>https://www.bestoftheatre.co.uk/blog/post/review-roundup-don-blacks-from-the-heart-garrick-theatre</loc><lastmod>2026-10-09T12:00:00+01:00</lastmod></url>
<url><loc>https://www.bestoftheatre.co.uk/blog/post/reece-shearsmith-hugh-skinner-josh-finan-an-oak-tree</loc></url>
</urlset>`;

const OAK = { id: 'an-oak-tree-off-west-end-2026', title: 'An Oak Tree', venue: 'The Other Palace - Main Theatre', category: 'off-west-end', openingDate: '2026-10-08' };
const HEART = { id: 'from-the-heart-west-end-2026', title: 'From The Heart', venue: 'Garrick Theatre', category: 'west-end', openingDate: '2026-10-09' };

test('parses review blocks and the "Also reviewed by" paywalled row', () => {
  const rows = extractBestOfTheatreRows(PAGE);
  assert.deepEqual(rows, [
    { outlet: 'LondonTheatre1', critic: 'Chris Omaweng', stars: 4, url: 'https://www.londontheatre1.com/reviews/an-oak-tree-at-the-other-palace/' },
    { outlet: 'The Spy in the Stalls', critic: 'Giles Broadbent', stars: 3.5, url: 'https://thespyinthestalls.com/2026/10/an-oak-tree/' },
    { outlet: 'London Theatre Reviews', critic: null, stars: null, url: 'https://www.londontheatrereviews.co.uk/post.cfm?p=29317' },
    { outlet: 'The Stage', critic: 'Dave Fargnoli', stars: 4, url: 'https://www.thestage.co.uk/reviews/an-oak-tree-review-the-other-palace-tim-crouch-gwyneth-keyworth' },
  ]);
});

test('sitemap lists only round-up posts; slugs match their show only', () => {
  const entries = roundupEntries(SITEMAP);
  assert.equal(entries.length, 2);
  assert.equal(slugMatchesShow(entries[0].url, OAK), true);
  assert.equal(slugMatchesShow(entries[0].url, HEART), false);
  assert.equal(slugMatchesShow(entries[1].url, HEART), true, 'possessive credit before the title');
  assert.equal(slugMatchesShow(entries[1].url, OAK), false);
});

test('a longer London title wins the slug; a one-word lead is not a possessive credit', () => {
  const titles = ['the-play-that-goes-wrong', 'the-play', 'hamlet', 'ghosts'];
  const PLAY = { id: 'the-play', title: 'The Play', venue: 'Somewhere', category: 'west-end' };
  const HAMLET = { id: 'hamlet', title: 'Hamlet', venue: 'Somewhere', category: 'west-end' };
  assert.equal(slugMatchesShow('https://x/blog/post/review-roundup-the-play-that-goes-wrong-duchess-theatre', PLAY, titles), false);
  assert.equal(slugMatchesShow('https://x/blog/post/review-roundup-ghosts-hamlet-national-theatre', HAMLET, titles), false);
  assert.equal(slugMatchesShow('https://x/blog/post/review-roundup-hamlet-national-theatre', HAMLET, titles), true);
});

test('discovery fetches the matched page and title-validates it', async () => {
  const fetchPage = async (u) => ({ content: u.includes('sitemap') ? SITEMAP : PAGE });
  const r = await discoverBestOfTheatreRoundup(OAK, { fetchPage, log: () => {} });
  assert.equal(r.url, 'https://www.bestoftheatre.co.uk/blog/post/review-roundup-an-oak-tree-the-other-palace');
  assert.equal(r.postDate, '2026-10-09T14:18:00+01:00');
  // From The Heart's round-up url matches, but this page's title is An Oak Tree: refused.
  assert.equal(await discoverBestOfTheatreRoundup(HEART, { fetchPage, log: () => {} }), null);
});

test('getWeReferenceRows carries Best of Theatre rows', async () => {
  const fetchPage = async (u) => {
    if (u.includes('bestoftheatre')) return { content: u.includes('sitemap') ? SITEMAP : PAGE };
    throw new Error('offline');
  };
  const ref = await getWeReferenceRows(OAK, { fetchPage, fetchJSON: async () => { throw new Error('offline'); }, log: () => {}, dataDir: '/nonexistent' });
  assert.equal(ref.sources.bestoftheatre.found, true);
  assert.equal(ref.sources.bestoftheatre.rows, 4);
  const lt1 = ref.rows.find((r) => r.source === 'bestoftheatre' && /londontheatre1/.test(r.url));
  assert.ok(lt1, 'LondonTheatre1 row present');
  assert.equal(lt1.priorRun, false);
  assert.equal(ref.allSourcesFailed, false, 'one working source is enough');
});
