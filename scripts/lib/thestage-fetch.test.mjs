import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  parseRoundupUrls, parseArticleSitemaps, classifyRoundupPage,
  discoverRoundupUrlsPlain, LOGIN_EXPIRED_MESSAGE,
} = require('./thestage-fetch.js');
const { extractReviews } = require('./thestage-extract.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.join(here, '..', '..', 'data', 'aggregator-archive', 'thestage-roundups');

const SITEMAP = `<?xml version="1.0"?><urlset>
<url><loc>https://www.thestage.co.uk/review-round-ups/arcadia-review-round-up</loc></url>
<url><loc>https://www.thestage.co.uk/review-round-ups/the-hills-of-california-review-round-up/</loc></url>
<url><loc>https://www.thestage.co.uk/review-round-ups/arcadia-review-round-up</loc></url>
<url><loc>https://www.thestage.co.uk/news/some-news-story</loc></url>
<url><loc>https://evil.example.com/review-round-ups/x-review-round-up</loc></url>
</urlset>`;

const INDEX = `<sitemapindex>
<sitemap><loc>https://www.thestage.co.uk/SiteMap_TheStage_Articles1_v2.xml</loc></sitemap>
<sitemap><loc>https://www.thestage.co.uk/SiteMap_TheStage_Jobs1_v2.xml</loc></sitemap>
</sitemapindex>`;

test('parseRoundupUrls keeps only Stage roundup paths, normalised and de-duplicated', () => {
  assert.deepEqual(parseRoundupUrls(SITEMAP), [
    'https://www.thestage.co.uk/review-round-ups/arcadia-review-round-up',
    'https://www.thestage.co.uk/review-round-ups/the-hills-of-california-review-round-up',
  ]);
});

test('parseRoundupUrls reads listing-page hrefs too', () => {
  const html = '<a href="/review-round-ups/hamlet-review-round-up">Hamlet</a><a href="/jobs">x</a>';
  assert.deepEqual(parseRoundupUrls(html), ['https://www.thestage.co.uk/review-round-ups/hamlet-review-round-up']);
});

test('parseArticleSitemaps picks article sitemaps only', () => {
  assert.deepEqual(parseArticleSitemaps(INDEX), ['https://www.thestage.co.uk/SiteMap_TheStage_Articles1_v2.xml']);
});

test('classifyRoundupPage separates a dead login from a challenge and template drift', () => {
  assert.equal(classifyRoundupPage('<html/>', 3), 'ok');
  assert.equal(classifyRoundupPage('<a href="/x?utm_source=Reggate">Subscribe to continue</a>', 0), 'gated');
  assert.equal(classifyRoundupPage('<title>Just a moment...</title> Subscribe to continue', 0), 'challenge');
  assert.equal(classifyRoundupPage('<html><body>nothing</body></html>', 0), 'empty');
});

test('discoverRoundupUrlsPlain merges sitemap and listing, survives one failing source', async () => {
  const bodies = {
    'https://www.thestage.co.uk/SiteMap_TheStage_index.xml': INDEX,
    'https://www.thestage.co.uk/SiteMap_TheStage_Articles1_v2.xml': SITEMAP,
    'https://www.thestage.co.uk/review-round-ups/review-round-ups': '<a href="/review-round-ups/hamlet-review-round-up">h</a>',
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => bodies[url] });
  const urls = await discoverRoundupUrlsPlain({ fetchImpl, log: () => {} });
  assert.equal(urls.length, 3);

  const failing = async (url) => url.includes('SiteMap') ? { ok: false, status: 503, text: async () => '' } : fetchImpl(url);
  const fallback = await discoverRoundupUrlsPlain({ fetchImpl: failing, log: () => {} });
  assert.deepEqual(fallback, ['https://www.thestage.co.uk/review-round-ups/hamlet-review-round-up']);
});

test('login-expired message tells the owner what to check, in plain words', () => {
  assert.match(LOGIN_EXPIRED_MESSAGE, /Only the Mac can renew/);
});

test('real archived roundup pages extract rows and are not classed gated', { skip: !fs.existsSync(ARCHIVE) }, () => {
  const files = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith('.html')).slice(0, 5);
  assert.ok(files.length > 0);
  let withRows = 0;
  for (const f of files) {
    const html = fs.readFileSync(path.join(ARCHIVE, f), 'utf8');
    const rows = extractReviews(html, f.replace('.html', ''));
    if (rows.length > 0) { withRows++; assert.equal(classifyRoundupPage(html, rows.length), 'ok'); }
  }
  assert.ok(withRows >= 1);
});

test('parseRoundupUrls keeps venue-suffixed roundup slugs and drops the index pages', () => {
  const xml = `<urlset>
<url><loc>https://www.thestage.co.uk/review-round-ups/arcadia-at-the-old-vic-london-review-round-up-tom-stoppard</loc></url>
<url><loc>https://www.thestage.co.uk/review-round-ups/born-with-teeth-review-round-up-wyndhams-theatre-london</loc></url>
<url><loc>https://www.thestage.co.uk/review-round-ups/martin-guerre-at-the-old-vic-london-review-round-up</loc></url>
<url><loc>https://www.thestage.co.uk/review-round-ups/review-round-ups</loc></url>
</urlset>`;
  const urls = parseRoundupUrls(xml);
  assert.equal(urls.length, 3);
  assert.ok(!urls.some((u) => u.endsWith('/review-round-ups')));
});

test('zeroDataFailure flags a run where every fetch failed even with cached archives', () => {
  const { zeroDataFailure } = require('../scrape-thestage-roundups.js');
  assert.match(zeroDataFailure({ pagesChecked: 0, cached: 35, reviewsExtracted: 0, fetchErrors: 12 }), /Every Stage page fetch failed/);
  assert.equal(zeroDataFailure({ pagesChecked: 3, cached: 35, reviewsExtracted: 0, fetchErrors: 12 }), null);
  assert.equal(zeroDataFailure({ pagesChecked: 0, cached: 35, reviewsExtracted: 0, fetchErrors: 0 }), null);
});
