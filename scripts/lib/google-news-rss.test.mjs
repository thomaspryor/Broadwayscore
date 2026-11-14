import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { googleNewsRssUrl, parseGoogleNewsItems, publisherUrlFromPage, discoverGoogleNewsReviews, isReviewHeadline } = require('./google-news-rss');
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
  return discoverGoogleNewsReviews(show, { now, fetchPageImpl, feedImpl: async () => null, decodeImpl: async () => null, ...opts }).then(results => ({ results, calls }));
};

test('the channel is wired into both existing opening-night callers and the poll summary', () => {
  const poller = fs.readFileSync(new URL('../opening-night-poller.js', import.meta.url), 'utf8');
  const gather = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  for (const caller of [poller, gather]) {
    assert.match(caller, /require\('\.\/lib\/google-news-rss'\)/);
    assert.match(caller, /discoverGoogleNewsReviews\(show, \{ knownUrls/);
  }
  // BRO-5674: layers 1-3 are processed before SERP, via preSerpDiscovered
  assert.match(poller, /preSerpDiscovered = \[.*\.\.\.googleNewsResults\]/);
  assert.match(poller, /allDiscovered = \[\.\.\.preSerpDiscovered/);
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
  // 23:35 UTC is 00:35 BST on the 22nd at a UK publisher: the reader-visible date is the local one (BRO-5499).
  assert.equal(results[0].publishDate, '2026-09-22');
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
    now, feedImpl: async () => null, decodeImpl: async () => null,
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

// Realistic Google News RSS shape (channel metadata, guid, entity-escaped HTML
// description, "<headline> - <Outlet>" titles). One item per filter branch.
const realisticFeed = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>
<generator>NFE/5.0</generator><title>"${show.title}" review - Google News</title>
<link>https://news.google.com/search?q=%22Catarina%22+review&amp;hl=en-GB&amp;gl=GB&amp;ceid=GB:en</link>
<language>en-GB</language><webMaster>news-webmaster@google.com</webMaster>
<copyright>2026 Google LLC. All rights reserved.</copyright><lastBuildDate>Tue, 22 Sep 2026 01:58:00 GMT</lastBuildDate>
<description>Google News</description>
<item><title>${show.title} review – a bracing, furious evening - The Guardian</title><link>https://news.google.com/rss/articles/CBMiGuardian?oc=5</link><guid isPermaLink="false">CBMiGuardian</guid><pubDate>Sun, 20 Sep 2026 21:10:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMiGuardian?oc=5" target="_blank"&gt;${show.title} review&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;The Guardian&lt;/font&gt;</description><source url="https://www.theguardian.com">The Guardian</source></item>
<item><title>${show.title} review: Chilean dark comedy - The Telegraph</title><link>https://news.google.com/rss/articles/CBMiTelegraphA?oc=5</link><guid isPermaLink="false">CBMiTelegraphA</guid><pubDate>Mon, 21 Sep 2026 23:35:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMiTelegraphA?oc=5"&gt;review&lt;/a&gt;</description><source url="https://www.telegraph.co.uk">The Telegraph</source></item>
<item><title>${show.title} review: Chilean dark comedy - The Telegraph</title><link>https://news.google.com/rss/articles/CBMiTelegraphAMP?oc=5</link><guid isPermaLink="false">CBMiTelegraphAMP</guid><pubDate>Mon, 21 Sep 2026 23:40:00 GMT</pubDate><description>dup</description><source url="https://www.telegraph.co.uk">The Telegraph</source></item>
<item><title>${show.title} review – Edinburgh fringe run - The Guardian</title><link>https://news.google.com/rss/articles/CBMiGuardianOld?oc=5</link><guid isPermaLink="false">CBMiGuardianOld</guid><pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate><description>old</description><source url="https://www.theguardian.com">The Guardian</source></item>
<item><title>Hamilton review – still the room where it happens - The Guardian</title><link>https://news.google.com/rss/articles/CBMiHamilton?oc=5</link><guid isPermaLink="false">CBMiHamilton</guid><pubDate>Mon, 21 Sep 2026 22:00:00 GMT</pubDate><description>other</description><source url="https://www.theguardian.com">The Guardian</source></item>
</channel></rss>`;

test('realistic feed: keeps post-preview reviews, drops pre-preview, other-show and duplicate items', async () => {
  const targets = {
    'https://news.google.com/rss/articles/CBMiGuardian?oc=5': 'https://www.theguardian.com/stage/2026/sep/20/catarina-review',
    'https://news.google.com/rss/articles/CBMiTelegraphA?oc=5': publisher,
    'https://news.google.com/rss/articles/CBMiTelegraphAMP?oc=5': `${publisher}?utm_source=googlenews&utm_medium=rss#comments`,
  };
  const resolve = async url => {
    const dest = targets[url] || (url.startsWith('https://news.google.com/') ? null : url);
    if (!dest) throw new Error(`unexpected redirect fetch ${url}`);
    return { finalUrl: dest, content: `<link rel="canonical" href="${dest.split(/[?#]/)[0]}"><meta name="author" content="Arifa Akbar">` };
  };
  const parsed = parseGoogleNewsItems(realisticFeed);
  assert.equal(parsed.length, 5, 'channel-level <title>/<link> must not become items');
  assert.equal(parsed[0].sourceUrl, 'https://www.theguardian.com');

  const { results, calls } = await discover(realisticFeed, {}, resolve);
  const urls = results.map(r => r.url).sort();
  // 2026-09-20 is after previewsStartDate (09-19) but before openingDate (09-21):
  // the bound must be previews, not opening night.
  assert.deepEqual(urls, [publisher, 'https://www.theguardian.com/stage/2026/sep/20/catarina-review'].sort());
  assert.ok(results.every(r => r.source === 'google-news-rss' && r.dateSource === 'google-news-rss'));
  assert.equal(results.find(r => r.outletId === 'guardian').publishDate, '2026-09-20');
  // Pre-preview and other-show items are filtered before any redirect fetch.
  assert.ok(!calls.some(c => /CBMiGuardianOld|CBMiHamilton/.test(c.url)));

  // Dedupe against URLs already on file in review-texts (knownUrls).
  const known = await discover(realisticFeed, { knownUrls: new Set([publisher]) }, resolve);
  assert.deepEqual(known.results.map(r => r.outletId), ['guardian']);
});

// Headline shapes copied from the live Google News feed for The Cherry Orchard
// (West End, opened 2026-10-13), where the Telegraph and Independent reviews
// carry no "review" in the headline (BRO-3998).
test('accepts review-free same-show headlines only from opening day to +2 days, never feature shapes', () => {
  const orchard = { title: 'The Cherry Orchard', openingDate: '2026-10-13', previewsStartDate: '2026-10-03' };
  const h = (title, date) => isReviewHeadline({ title, pubDate: new Date(date) }, orchard);
  assert.equal(h('Kristin Scott Thomas is hypnotic in a riveting Cherry Orchard - The Telegraph', '2026-10-13T23:01:00Z'), true);
  assert.equal(h('The Cherry Orchard with Kristin Scott Thomas is very, very funny... until it’s not - The Independent', '2026-10-14T09:04:00Z'), true);
  assert.equal(h('Kristin Scott Thomas is hypnotic in a riveting Cherry Orchard - The Telegraph', '2026-10-16T09:00:00Z'), false, 'day +3 needs the word review');
  assert.equal(h('The Cherry Orchard review at the Harold Pinter Theatre, London - The Stage', '2026-10-20T08:11:00Z'), true);
  assert.equal(h('Kristin Scott Thomas rehearses a new Cherry Orchard - The Times', '2026-10-12T09:00:00Z'), false, 'previews need the word review');
  assert.equal(h("First look at Kristin Scott Thomas in 'The Cherry Orchard' in the West End - London Theatre", '2026-10-13T17:52:03Z'), false);
  assert.equal(h('The Cherry Orchard Reviews: critics praise Kristin Scott Thomas, but split on Stephen Mangan - West End Theatre', '2026-10-14T10:22:32Z'), false);
  assert.equal(h('The 12 best shows to book this autumn — from The Cherry Orchard to Rent - The Times', '2026-10-13T07:00:00Z'), false);
  assert.equal(h('Nina at Battersea Arts Centre Council Chamber, London: searing experience - The Stage', '2026-10-14T10:30:00Z'), false);
});

test('discovers a Telegraph review whose headline omits the word review', async () => {
  const headline = 'Lorca-tinged black comedy grips in Catarina and the Beauty of Killing Fascists - The Telegraph';
  const { results } = await discover(feed(item({ title: headline })));
  assert.equal(results.length, 1);
  assert.equal(results[0].outletId, 'telegraph');
  assert.equal(results[0].url, publisher);
});

test('akaTitles: the press title is searched and matched (Billy Crystal 860 is reviewed as "860")', () => {
  const { searchTitles, googleNewsRssUrl, isReviewHeadline } = createRequire(import.meta.url)('./google-news-rss.js');
  const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860', 'billy crystal 860', ''], category: 'broadway', openingDate: '2026-10-21' };
  assert.deepEqual(searchTitles(show), ['Billy Crystal 860', '860']);
  assert.equal(new URL(googleNewsRssUrl(show)).searchParams.get('q'), '"Billy Crystal 860" OR "860" review');
  assert.ok(isReviewHeadline({ title: "'860' Broadway Review: Billy Crystal Remembers The Good Stuff And The Bad - Deadline", pubDate: 'Thu, 22 Oct 2026 02:00:00 GMT' }, show));
  assert.ok(!isReviewHeadline({ title: 'New Balance Fresh Foam X 860 v15 Review (2026) - Doctors of Running', pubDate: 'Thu, 22 Oct 2026 02:00:00 GMT' }, show));
  assert.ok(isReviewHeadline({ title: '860: Billy Crystal Brings Down the House - New York Stage Review', pubDate: 'Thu, 22 Oct 2026 02:00:00 GMT' }, show));
  assert.equal(new URL(googleNewsRssUrl({ title: 'Hamlet', category: 'broadway' })).searchParams.get('q'), '"Hamlet" review');
});

// BRO-6589: HTTP decode first, Playwright wrapper wait only as the fallback.
const { decodeGoogleNewsLink, fetchGoogleNewsFeed, wrapperId, parseDecodeParams, parseBatchResponse } = require('./google-news-decode');

test('a decoded wrapper skips the Playwright wait and still fetches the article for the byline', async () => {
  const { results, calls } = await discover(feed(item()), { decodeImpl: async () => publisher });
  assert.equal(results[0].url, publisher);
  assert.equal(results[0].criticName, 'Dominic Cavendish');
  assert.ok(!calls.some(c => c.url === wrapper), 'wrapper must not be opened in Playwright');
  assert.ok(calls.some(c => c.url === publisher && c.options.fast));
});

test('a decoded URL on the wrong domain falls back to the Playwright wrapper path', async () => {
  const { results, calls } = await discover(feed(item()), { decodeImpl: async () => 'https://evil.example/review' });
  assert.equal(results[0].url, publisher);
  assert.ok(calls.some(c => c.url === wrapper && c.options.playwrightWaitForSelector));
});

test('decode stops for the batch after two straight misses', async () => {
  let decodes = 0;
  const links = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(x => item({ link: `${wrapper}${x}` }));
  await discover(feed(...links), { decodeImpl: async () => { decodes++; return null; } });
  // Three workers can each start one decode before the second miss lands.
  assert.ok(decodes >= 2 && decodes <= 3, `decodes=${decodes}`);
});

test('resolves items three at a time and keeps feed order in the results', async () => {
  let inFlight = 0, peak = 0;
  const pubs = ['a', 'b', 'c', 'd', 'e'].map(x => publisher.replace('catarina-review', `review-${x}`));
  const xml = feed(...pubs.map((_, i) => item({ link: `${wrapper}${i}` })));
  const { results } = await discover(xml, { decodeImpl: async link => pubs[Number(link.slice(-1))] }, async url => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 20));
    inFlight--;
    return { content: `<link rel="canonical" href="${url}">`, finalUrl: url };
  });
  assert.equal(peak, 3);
  assert.deepEqual(results.map(r => r.url), pubs);
});

test('google-news-decode parses Google article params and batchexecute replies', async () => {
  assert.equal(wrapperId('https://news.google.com/rss/articles/CBMiAU_yqL-x?oc=5'), 'CBMiAU_yqL-x');
  assert.equal(wrapperId('https://evil.example/rss/articles/CBMi'), null);
  assert.deepEqual(parseDecodeParams('<c-wiz data-n-a-sg="SIG" data-n-a-ts="1761800000">'), { sg: 'SIG', ts: 1761800000 });
  assert.equal(parseDecodeParams('<html></html>'), null);
  const reply = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"${publisher}\\",1]",null,null,null,"generic"]]`;
  assert.equal(parseBatchResponse(reply), publisher);
  assert.equal(parseBatchResponse(')]}\'\n[["er",null]]'), null);
  assert.equal(parseBatchResponse('not json'), null);

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (!init.method) return { ok: true, text: async () => '<div data-n-a-sg="SIG" data-n-a-ts="17"></div>' };
    return { ok: true, text: async () => reply };
  };
  assert.equal(await decodeGoogleNewsLink('https://news.google.com/rss/articles/CBMiabc?oc=5', { fetchImpl }), publisher);
  assert.ok(seen.every(c => c.init.signal), 'every request carries a timeout signal');
  assert.match(decodeURIComponent(seen[1].init.body), /Fbv4je/);
  assert.equal(await decodeGoogleNewsLink('https://news.google.com/rss/articles/CBMiabc', { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await decodeGoogleNewsLink('https://news.google.com/rss/articles/CBMiabc', { fetchImpl: async () => { throw new Error('reset'); } }), null);
});

test('the feed is read over plain HTTP first and through fetchPage only when that fails', async () => {
  const xml = feed(item());
  const viaHttp = await discover('', { feedImpl: async () => xml });
  assert.equal(viaHttp.results.length, 1);
  assert.ok(!viaHttp.calls.some(c => c.url.includes('/rss/search?')), 'no Playwright feed fetch when HTTP worked');
  const viaPage = await discover(xml, { feedImpl: async () => null });
  assert.equal(viaPage.results.length, 1);
  assert.ok(viaPage.calls.some(c => c.url.includes('/rss/search?')));

  const ok = { ok: true, text: async () => xml };
  assert.equal(await fetchGoogleNewsFeed('https://news.google.com/rss/search?q=x', { fetchImpl: async () => ok }), xml);
  assert.equal(await fetchGoogleNewsFeed('https://evil.example/rss', { fetchImpl: async () => ok }), null);
  assert.equal(await fetchGoogleNewsFeed('http://news.google.com/rss/search?q=x', { fetchImpl: async () => ok }), null);
  assert.equal(await fetchGoogleNewsFeed('https://news.google.com/rss/search?q=x', { fetchImpl: async () => ({ ok: true, text: async () => '<html>consent</html>' }) }), null);
  assert.equal(await fetchGoogleNewsFeed('https://news.google.com/rss/search?q=x', { fetchImpl: async () => ({ ok: false }) }), null);
  // An empty feed is still a feed: no fallback to the slow Playwright fetch.
  const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
  assert.equal(await fetchGoogleNewsFeed('https://news.google.com/rss/search?q=x', { fetchImpl: async () => ({ ok: true, text: async () => empty }) }), empty);
});

test('BRO-6589: an empty feed over HTTP returns no candidates and never opens the browser', async () => {
  let pageCalls = 0;
  const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
  const results = await discoverGoogleNewsReviews(show, {
    now, feedImpl: async () => empty, decodeImpl: async () => null,
    fetchPageImpl: async () => { pageCalls++; return null; },
  });
  assert.deepEqual(results, []);
  assert.equal(pageCalls, 0);
});
