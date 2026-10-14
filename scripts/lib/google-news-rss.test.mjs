import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { googleNewsRssUrl, parseGoogleNewsItems, publisherUrlFromPage, discoverGoogleNewsReviews } = require('./google-news-rss');
const show = { id: 'catarina-west-end-2026', title: 'Catarina and the Beauty of Killing Fascists', category: 'west-end', openingDate: '2026-09-21', previewsStartDate: '2026-09-19' };
const now = new Date('2026-09-22T02:00:00Z');
const publisher = 'https://www.telegraph.co.uk/theatre/what-to-see/catarina-review/';
const wrapper = 'https://news.google.com/rss/articles/opaque';
const item = ({ date = 'Mon, 21 Sep 2026 23:35:00 GMT', title = `${show.title} review`, link = wrapper, source = 'https://www.telegraph.co.uk' } = {}) => `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate><source url="${source}">The Telegraph</source></item>`;
const feed = (...items) => `<rss><channel>${items.join('')}</channel></rss>`;
const page = { content: `<link rel="canonical" href="${publisher}"><meta name="author" content="Dominic Cavendish">`, finalUrl: publisher };
const discover = (xml, opts = {}, resolve = async () => page) => {
  const calls = [];
  const fetchPageImpl = async (url, options) => {
    calls.push({ url, options });
    return url.includes('/rss/search?') ? { content: xml } : resolve(url);
  };
  return discoverGoogleNewsReviews(show, { now, fetchPageImpl, ...opts }).then(results => ({ results, calls }));
};

test('the channel is wired into both existing opening-night callers and the poll summary', () => {
  const poller = fs.readFileSync(new URL('../opening-night-poller.js', import.meta.url), 'utf8');
  const gather = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  for (const caller of [poller, gather]) {
    assert.match(caller, /require\('\.\/lib\/google-news-rss'\)/);
    assert.match(caller, /discoverGoogleNewsReviews\(show, \{ knownUrls/);
  }
  assert.match(poller, /allDiscovered = \[.*\.\.\.googleNewsResults\]/);
  assert.match(poller, /google-news-rss:\$\{googleNewsResults.length\}/);
});

test('queries the exact title and uses the show market locale', () => {
  const uk = new URL(googleNewsRssUrl(show));
  assert.equal(uk.searchParams.get('q'), `"${show.title}" review`);
  assert.equal(uk.searchParams.get('ceid'), 'GB:en');
  const us = new URL(googleNewsRssUrl({ ...show, category: 'broadway' }));
  assert.equal(us.searchParams.get('hl'), 'en-US');
  assert.equal(us.searchParams.get('gl'), 'US');
  assert.equal(us.searchParams.get('ceid'), 'US:en');
});

test('parses source, date, CDATA and XML entities', () => {
  const [parsed] = parseGoogleNewsItems(feed(item({ title: 'Catarina & the Beauty review', link: `${wrapper}?a=1&amp;b=2` })));
  assert.equal(parsed.title, 'Catarina & the Beauty review');
  assert.equal(parsed.link, `${wrapper}?a=1&b=2`);
  assert.equal(parsed.sourceName, 'The Telegraph');
  assert.equal(parsed.pubDate.toISOString(), '2026-09-21T23:35:00.000Z');
});

test('discovers a publisher URL and real byline through the shared fetch seam', async () => {
  const { results, calls } = await discover(feed(item()));
  assert.equal(results.length, 1);
  assert.equal(results[0].outletId, 'telegraph');
  assert.equal(results[0].criticName, 'Dominic Cavendish');
  assert.equal(results[0].source, 'google-news-rss');
  assert.equal(results[0].publishDate, '2026-09-21');
  assert.equal(results[0].url, publisher);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.options.preferPlaywright === true));
});

test('rejects old, future, invalid-date, different-show and non-review articles before resolution', async () => {
  const { results, calls } = await discover(feed(
    item({ date: '2024-09-21' }), item({ date: '2026-09-23' }), item({ date: 'invalid' }),
    item({ title: 'Hamilton review' }), item({ title: `${show.title} interview and review` }),
    item({ title: `${show.title} tickets` }),
  ));
  assert.deepEqual(results, []);
  assert.equal(calls.length, 1);
});

test('only polls bounded opening windows and requires a valid preview date', async () => {
  for (const opts of [{ now: new Date('2026-10-12') }, { now: new Date('2026-09-01') }, { previewsStartDate: 'invalid' }, { openingDate: null }]) {
    let calls = 0;
    const results = await discoverGoogleNewsReviews({ ...show, ...opts }, { now: opts.now || now, fetchPageImpl: async () => { calls++; } });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  }
});

test('normalizes known review URLs and dedupes multiple wrappers to the same article', async () => {
  const xml = feed(item(), item({ link: `${wrapper}2` }));
  const knownUrls = new Set([publisher.replace('https://www.', 'http://') + '?utm_source=rss#review']);
  assert.deepEqual((await discover(xml, { knownUrls })).results, []);
  assert.equal((await discover(xml)).results.length, 1);
});

test('accepts rendered redirects on blocked publisher pages and refuses mismatching hosts', () => {
  assert.equal(publisherUrlFromPage('<h1>Access Denied</h1>', 'https://telegraph.co.uk', publisher), publisher);
  assert.equal(publisherUrlFromPage('<link rel="canonical" href="https://evil.example/review">', 'https://telegraph.co.uk'), null);
  assert.equal(publisherUrlFromPage('', 'https://telegraph.co.uk', wrapper), null);
  assert.equal(publisherUrlFromPage('', 'https://telegraph.co.uk', 'https://telegraph.co.uk/'), null);
});

test('extracts only an unambiguous publisher link from the Google interstitial', async () => {
  const html = `<a href="${publisher}">Read article</a><a href="https://google.com/privacy">Privacy</a>`;
  assert.equal(publisherUrlFromPage(html, 'https://telegraph.co.uk'), publisher);
  assert.equal(publisherUrlFromPage(html + '<a href="https://telegraph.co.uk/other">Other</a>', 'https://telegraph.co.uk'), null);
  const { results, calls } = await discover(feed(item()), {}, async url => url === wrapper ? { content: html } : page);
  assert.equal(results[0].criticName, 'Dominic Cavendish');
  assert.equal(calls.length, 3);
});

test('keeps a resolved URL when the subsequent article fetch fails', async () => {
  const { results } = await discover(feed(item()), {}, async url => {
    if (url === wrapper) return { content: `<a href="${publisher}">Article</a>` };
    throw new Error('publisher unavailable');
  });
  assert.equal(results[0].url, publisher);
  assert.equal(results[0].criticName, 'Unknown');
});

test('reuses registry critic resolution for a first-name-only publisher byline', async () => {
  const url = 'https://newyorktheater.me/current-review/';
  const results = await discoverGoogleNewsReviews({ ...show, category: 'broadway' }, {
    now,
    fetchPageImpl: async requested => requested.includes('/rss/search?')
      ? { content: feed(item({ source: 'https://newyorktheater.me' })) }
      : { finalUrl: url, content: `<link rel="canonical" href="${url}"><meta name="author" content="Jonathan">` },
  });
  assert.equal(results[0].criticName, 'Jonathan Mandell');
});

test('isolates redirect failures, rejects unknown outlets and cross-market sources', async () => {
  const { results, calls } = await discover(feed(item({ source: 'https://unknown.example' }), item({ source: 'https://nypost.com' }), item(), item({ link: `${wrapper}2` })), {}, async url => {
    if (url === wrapper) throw new Error('timeout');
    return page;
  });
  assert.equal(results.length, 1);
  assert.equal(calls.length, 3);
});

test('checks shared-domain outlets against the resolved article edition', async () => {
  const xml = feed(item({ source: 'https://www.timeout.com' }));
  const london = await discover(xml, {}, async () => ({ finalUrl: 'https://www.timeout.com/london/theatre/catarina-review', content: '' }));
  assert.equal(london.results[0].outletId, 'timeout-london');
  const ny = await discover(xml, {}, async () => ({ finalUrl: 'https://www.timeout.com/newyork/theater/catarina-review', content: '' }));
  assert.deepEqual(ny.results, []);
});

test('limits redirect work to twelve distinct wrappers per show per cycle', async () => {
  const { calls } = await discover(feed(...Array.from({ length: 36 }, (_, i) => item({ link: `${wrapper}${i}` }))), {}, async () => ({ content: '' }));
  assert.equal(calls.length, 13);
});

test('rotates batches so duplicate nationals do not starve later items on subsequent polls', async () => {
  const xml = feed(...Array.from({ length: 24 }, (_, i) => item({ link: `${wrapper}${i}` })));
  const first = await discover(xml, {}, async () => ({ content: '' }));
  const next = await discover(xml, { now: new Date(now.getTime() + 15 * 60000) }, async () => ({ content: '' }));
  const wrappers = new Set(first.calls.slice(1).map(c => c.url));
  assert.equal(next.calls.slice(1).filter(c => wrappers.has(c.url)).length, 0);
  assert.equal(next.calls.length, 13);
});
