// The lane's page-tag review check (Vulture, 2026-11-23): a section-index find with no review word is judged by its
// article page's tag metadata instead of being refused not-review-like. Real functions, injected fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');

const SHOW = { id: 'its-a-wonderful-life-a-live-radio-play-2026', title: "It's a Wonderful Life: A Live Radio Play", category: 'broadway' };
const NIGHT = '2026-11-23';
const INDEX = 'https://www.vulture.com/theater/';
const REVIEW = 'https://www.vulture.com/article/its-a-wonderful-life-on-broadway-god-help-us-every-one.html';
const NEWS = 'https://www.vulture.com/article/its-a-wonderful-life-a-live-radio-play-rannells-hilty-burgess.html';

const indexHtml = `<html><body><nav><a href="/theater/">Theater</a></nav><main>
  <a href="${REVIEW}">God Help Us, Every One: It’s a Wonderful Life on Broadway</a>
  <a href="${NEWS}">It’s a Wonderful Life: A Live Radio Play, With Rannells, Hilty and Burgess</a>
</main></body></html>`;
const article = (tags) => `<html><head>
  <meta property="article:published_time" content="2026-11-24T02:28:00.000Z">
  <script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-11-24T02:28:00.000Z"}</script>
  <meta property="article:tag" content="${tags}">
  </head><body><article><p>Body text.</p></article></body></html>`;

function pass(pages, memo = { rejected: {} }) {
  return d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: Date.parse('2026-11-24T03:00:00Z'), startedAt: Date.parse('2026-11-23T21:00:00Z'), timeZone: 'America/New_York',
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'vulture', indexUrl: INDEX, pinned: true }] })],
    fetchText: async (u) => { if (u in pages) return pages[u]; throw new Error(`no page ${u}`); }, memo,
  });
}

test('pageTagsSayReview reads article:tag / parsely-tags / keywords, whole tags only', () => {
  assert.equal(d.pageTagsSayReview(article('theater, review, theater review, andrew rannells')), true);
  assert.equal(d.pageTagsSayReview('<meta name="parsely-tags" content="theater, featuretype:review">'), true);
  assert.equal(d.pageTagsSayReview(article('theater, stage whisperer, off broadway, broadway')), false, 'a news story');
  assert.equal(d.pageTagsSayReview(article('theater, reviews of the year')), false, 'a tag that only contains the word');
  assert.equal(d.pageTagsSayReview('<p>theater review</p>'), false, 'body text is not a tag');
  assert.equal(d.pageTagsSayReview(''), false);
  assert.equal(d.pageTagsSayReview('<meta name="keywords" data-content="review" content="theater">'), false, 'data-content is not the content attribute');
});

test('a Vulture index find with no review word is admitted when its page is tagged a review; tagged news is refused for good', async () => {
  const memo = { rejected: {} };
  const r = await pass({ [INDEX]: indexHtml, [REVIEW]: article('theater, review, theater review'), [NEWS]: article('theater, broadway, photos') }, memo);
  assert.deepEqual(r.admitted.map((a) => a.key), [d.canonicalUrl(REVIEW)]);
  assert.equal((r.rejected.find((x) => x.url === d.canonicalUrl(NEWS)) || {}).reason, 'page-not-tagged-review');
  assert.equal(memo.rejected[d.canonicalUrl(NEWS)].reason, 'page-not-tagged-review', 'final: the news page is not fetched again');
});

test('a page with no date of its own (a challenge page) is a strike, never a verdict', async () => {
  const memo = { rejected: {} };
  const r = await pass({ [INDEX]: indexHtml, [REVIEW]: '<html><body>Just a moment...</body></html>', [NEWS]: article('theater') }, memo);
  assert.equal(r.admitted.length, 0);
  assert.equal(memo.rejected[d.canonicalUrl(REVIEW)].reason, 'date-check-failed');
});

test('a find an earlier deploy refused not-review-like gets its page check (the 2026-11-23 memo)', async () => {
  const memo = { rejected: { [d.canonicalUrl(REVIEW)]: { reason: 'not-review-like', attempts: 40 } } };
  const r = await pass({ [INDEX]: indexHtml, [REVIEW]: article('theater, theater review'), [NEWS]: article('theater') }, memo);
  assert.deepEqual(r.admitted.map((a) => a.key), [d.canonicalUrl(REVIEW)]);
});

test('other hosts keep the old rule: no review word, refused not-review-like without a fetch', async () => {
  const VAR_INDEX = 'https://variety.com/v/legit/reviews/';
  const VAR = 'https://variety.com/2026/legit/its-a-wonderful-life-on-broadway-god-help-us-1236000000/';
  const fetched = [];
  const r = await d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: Date.parse('2026-11-24T03:00:00Z'), startedAt: Date.parse('2026-11-23T21:00:00Z'), timeZone: 'America/New_York',
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'variety', indexUrl: VAR_INDEX, pinned: true }] })],
    fetchText: async (u) => { fetched.push(u); if (u === VAR_INDEX) return `<main><a href="${VAR}">It’s a Wonderful Life on Broadway: God Help Us</a></main>`; return article('theater review'); },
  });
  assert.equal((r.rejected.find((x) => x.url === d.canonicalUrl(VAR)) || {}).reason, 'not-review-like');
  assert.ok(!fetched.includes(VAR));
});

test('a Google News sighting that already dates the review does not skip the page check (second-opinion blocker)', async () => {
  // Google News emits source 'outlet-index' with its feed date (needsDate false) and runs before the section index.
  const gn = { name: 'google-news', kind: 'outlet-index', phase: 'cheap',
    async discover() { return [{ url: REVIEW, title: 'God Help Us, Every One: It’s a Wonderful Life on Broadway', source: 'outlet-index', publishDate: '2026-11-24T02:28:00.000Z', needsDate: false, via: 'google-news', vettedOutlet: true }]; } };
  const run = (reviewPage) => d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: Date.parse('2026-11-24T03:00:00Z'), startedAt: Date.parse('2026-11-23T21:00:00Z'), timeZone: 'America/New_York',
    adapters: [gn, d.sectionIndexAdapter({ outlets: [{ outletId: 'vulture', indexUrl: INDEX, pinned: true }] })],
    fetchText: async (u) => (u === INDEX ? indexHtml : u === REVIEW ? reviewPage : article('theater')),
  });
  const tagged = await run(article('theater, theater review'));
  assert.deepEqual(tagged.admitted.map((a) => a.key), [d.canonicalUrl(REVIEW)]);
  const untagged = await run(article('theater, broadway'));
  assert.equal(untagged.admitted.length, 0, 'a dated sighting is still checked against the page tags');
  assert.equal((untagged.rejected.find((x) => x.url === d.canonicalUrl(REVIEW)) || {}).reason, 'page-not-tagged-review');
});

test('a page-not-tagged-review verdict is judged again when a later sighting carries a review word', async () => {
  const memo = { rejected: { [d.canonicalUrl(REVIEW)]: { reason: 'page-not-tagged-review', attempts: 1 } } };
  const titled = `<main><a href="${REVIEW}">Theater Review: It’s a Wonderful Life on Broadway</a></main>`;
  const r = await d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: Date.parse('2026-11-24T03:00:00Z'), startedAt: Date.parse('2026-11-23T21:00:00Z'), timeZone: 'America/New_York',
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'vulture', indexUrl: INDEX, pinned: true }] })],
    fetchText: async (u) => (u === INDEX ? titled : article('theater')), memo,
  });
  assert.deepEqual(r.admitted.map((a) => a.key), [d.canonicalUrl(REVIEW)]);
});

test('tag parsing: entities decoded, a bare "review" or "movie review" tag does not count (ship-check)', () => {
  assert.equal(d.pageTagsSayReview('<meta property="article:tag" content="theater, Theater&#x20;Review">'), true);
  assert.equal(d.pageTagsSayReview('<meta name="keywords" content="film, review">'), false, 'bare review');
  assert.equal(d.pageTagsSayReview('<meta name="keywords" content="movie review, theater">'), false);
});

test('a redirected page, or a direct-only page with no date, is never a tag verdict (ship-check)', async () => {
  const withPage = (page) => d.runDiscoveryPass({
    show: SHOW, night: NIGHT, now: Date.parse('2026-11-24T03:00:00Z'), startedAt: Date.parse('2026-11-23T21:00:00Z'), timeZone: 'America/New_York',
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'vulture', indexUrl: INDEX, pinned: true }] })],
    fetchText: async (u, opts = {}) => (u === INDEX ? indexHtml : u === REVIEW ? (opts.withFinalUrl ? page : page.content) : article('theater')),
    memo: { rejected: {} },
  });
  const moved = await withPage({ content: article('theater, broadway'), finalUrl: 'https://www.vulture.com/theater/' });
  assert.equal((moved.rejected.find((x) => x.url === d.canonicalUrl(REVIEW)) || {}).reason, undefined, 'no final verdict on a redirect');
  assert.equal(moved.admitted.length, 0);
  const directOnly = await withPage({ content: '<html>Just a moment...</html>', finalUrl: REVIEW, laneDirectOnly: true });
  assert.equal(directOnly.admitted.length, 0);
  assert.ok(directOnly.deferredDateChecks.includes(REVIEW) || directOnly.deferredDateChecks.includes(d.canonicalUrl(REVIEW)));
});
