import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

// A realistic reddit search.rss Atom body (single entry), single-level XML
// entity escaping — matches what reddit.com actually serves.
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<category term="Broadway" label="r/Broadway"/>
<updated>2026-07-21T12:00:00+00:00</updated>
<id>/r/Broadway/search.rss?q=Hamilton</id>
<link rel="self" href="https://www.reddit.com/r/Broadway/search.rss?q=Hamilton" type="application/atom+xml"/>
<title>Hamilton - search results</title>
<entry>
<author><name>/u/theatrefan99</name><uri>https://www.reddit.com/user/theatrefan99</uri></author>
<category term="Broadway" label="r/Broadway"/>
<content type="html">&lt;table&gt; &lt;tr&gt;&lt;td&gt; &lt;a href="https://href"&gt;&lt;img src="thumb.jpg"&gt;&lt;/a&gt; &lt;/td&gt;&lt;td&gt; &lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Anyone have extra Hamilton &amp;amp; Playbill tickets for this weekend?&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; submitted by &lt;a href="https://www.reddit.com/user/theatrefan99"&gt; /u/theatrefan99 &lt;/a&gt; &lt;br&gt; &lt;span&gt;&lt;a href="https://redd.it/1abcxyz"&gt;[link]&lt;/a&gt;&lt;/span&gt; &lt;span&gt;&lt;a href="https://www.reddit.com/r/Broadway/comments/1abcxyz/hamilton_tickets/"&gt;[92 comments]&lt;/a&gt;&lt;/span&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
<id>t3_1abcxyz</id>
<link href="https://www.reddit.com/r/Broadway/comments/1abcxyz/hamilton_tickets/" />
<published>2026-07-20T18:30:00+00:00</published>
<title>Hamilton &amp; Playbill tickets question</title>
</entry>
</feed>`;

// Two entries: one with a normal /comments/ link, one whose entry link is
// something else entirely (crosspost/promoted-shape) — the second must be
// dropped by the postId regex, and that drop must be visible (console.warn).
const FEED_WITH_UNPARSEABLE_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<author><name>/u/theatrefan99</name></author>
<content type="html">&lt;p&gt;Good entry&lt;/p&gt;</content>
<id>t3_good1</id>
<link href="https://www.reddit.com/r/Broadway/comments/good1/a_post/" />
<published>2026-07-20T18:30:00+00:00</published>
<title>Good post</title>
</entry>
<entry>
<author><name>/u/other</name></author>
<content type="html">&lt;p&gt;Weird entry&lt;/p&gt;</content>
<id>weird</id>
<link href="https://www.reddit.com/promoted/xyz" />
<published>2026-07-20T18:31:00+00:00</published>
<title>Unparseable link</title>
</entry>
</feed>`;

// A post's comments.rss: first entry is the post (t3_), the rest are comments (t1_).
const COMMENTS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><author><name>/u/op</name></author><content type="html">&lt;p&gt;Loved it&lt;/p&gt;</content><id>t3_1abcxyz</id><link href="https://www.reddit.com/r/Broadway/comments/1abcxyz/x/"/><title>x</title></entry>
<entry><author><name>/u/kuomodo_g</name></author><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Wow, so jealous! I love &amp;amp; hear it is good.&lt;/p&gt; &lt;/div&gt;&lt;!-- SC_ON --&gt;</content><id>t1_phjg4gy</id><link href="https://www.reddit.com/r/Broadway/comments/1abcxyz/x/phjg4gy/"/><updated>2026-10-18T18:01:11+00:00</updated><title>c</title></entry>
</feed>`;

let flakyHits = 0;
let commentsRssHit = false;
let rateLimitedHits = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/r/Broadway/comments/1abcxyz/.rss') {
    // BRO-5916: comments go through RSS too (`<id>.json` -> `<id>/.rss`)
    commentsRssHit = true;
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(COMMENTS_FEED);
    return;
  }
  if (u.pathname === '/r/Broadway/flaky.rss') {
    // 429 once (reset 0s), then a real feed: fetchViaRedditRSS must wait and retry
    flakyHits++;
    if (flakyHits === 1) {
      res.writeHead(429, { 'x-ratelimit-reset': '0' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(SAMPLE_FEED);
    return;
  }
  if (u.pathname === '/r/Broadway/search.rss') {
    // Reddit RSS caps at 25 — assert the caller trimmed a bigger request limit.
    assert.notEqual(u.searchParams.get('limit'), '100', 'limit must be capped before hitting reddit');
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(SAMPLE_FEED);
    return;
  }
  if (u.pathname === '/r/Broadway/partial.rss') {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(FEED_WITH_UNPARSEABLE_ENTRY);
    return;
  }
  if (u.pathname === '/r/Broadway/empty.rss') {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end('<feed xmlns="http://www.w3.org/2005/Atom"></feed>');
    return;
  }
  if (u.pathname === '/r/Broadway/html.rss') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>blocked</body></html>');
    return;
  }
  if (u.pathname === '/r/Broadway/blocked.rss') {
    res.writeHead(403);
    res.end('blocked');
    return;
  }
  if (u.pathname === '/r/Broadway/ratelimited.rss') {
    rateLimitedHits++;
    res.writeHead(429);
    res.end('slow down');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
});

function load() {
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('../../scripts/lib/reddit-api.js')];
  return require('../../scripts/lib/reddit-api.js');
}

test('toRssUrl rewrites .json to .rss, caps limit at 25, drops raw_json', () => {
  const { toRssUrl } = load();
  const rss = toRssUrl('https://www.reddit.com/r/Broadway/search.json?q=Hamilton&limit=100&raw_json=1');
  const u = new URL(rss);
  assert.equal(u.pathname, '/r/Broadway/search.rss');
  assert.equal(u.searchParams.get('limit'), '25');
  assert.equal(u.searchParams.has('raw_json'), false);
  assert.equal(u.searchParams.get('q'), 'Hamilton');
});

test('toRssUrl leaves a limit under 25 untouched', () => {
  const { toRssUrl } = load();
  const rss = toRssUrl('https://www.reddit.com/r/Broadway/search.json?q=x&limit=10');
  assert.equal(new URL(rss).searchParams.get('limit'), '10');
});

test('parseRedditAtom shapes an entry like the JSON search response', () => {
  const { parseRedditAtom } = load();
  const parsed = parseRedditAtom(SAMPLE_FEED);
  assert.equal(parsed.data.children.length, 1);
  const post = parsed.data.children[0].data;
  assert.equal(parsed.data.children[0].kind, 't3');
  assert.equal(post.id, '1abcxyz');
  assert.equal(post.name, 't3_1abcxyz');
  assert.equal(post.subreddit, 'Broadway');
  assert.equal(post.permalink, '/r/Broadway/comments/1abcxyz/hamilton_tickets/');
  assert.equal(post.author, 'theatrefan99');
  assert.equal(post.num_comments, 92);
  assert.equal(Math.round(post.created_utc), Math.round(Date.parse('2026-07-20T18:30:00+00:00') / 1000));
});

test('parseRedditAtom decodes a literal "&" in title exactly once (no double-decode corruption)', () => {
  const { parseRedditAtom } = load();
  const post = parseRedditAtom(SAMPLE_FEED).data.children[0].data;
  // Raw XML has `&amp;` once in <title> (single-escaped plain text) and
  // `&amp;amp;` once in <content> (HTML-escaped-then-XML-escaped) — both
  // must recover to a single literal "&", not "&amp;" and not stay escaped.
  assert.equal(post.title, 'Hamilton & Playbill tickets question');
  assert.ok(post.selftext.includes('Hamilton & Playbill tickets'), `selftext should contain a literal "&", got: ${post.selftext}`);
  assert.ok(!post.selftext.includes('&amp;'), `selftext must not retain an escaped &amp;, got: ${post.selftext}`);
});

test('parseRedditAtom returns null for a feed with no entries', () => {
  const { parseRedditAtom } = load();
  assert.equal(parseRedditAtom('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), null);
});

test('parseRedditAtom returns null for a non-XML body (e.g. an HTML block page)', () => {
  const { parseRedditAtom } = load();
  assert.equal(parseRedditAtom('<html><body>blocked</body></html>'), null);
});

test('parseRedditAtom drops entries with no parseable comments permalink and warns about it', () => {
  const { parseRedditAtom } = load();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const parsed = parseRedditAtom(FEED_WITH_UNPARSEABLE_ENTRY);
    assert.equal(parsed.data.children.length, 1, 'only the parseable entry should survive');
    assert.equal(parsed.data.children[0].data.id, 'good1');
    assert.ok(
      warnings.some((w) => /dropped 1\/2 entries/.test(w)),
      `expected a dropped-entry warning, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('fetchViaRedditRSS fetches and parses a live feed, counting stats.redditRss', async () => {
  const { fetchViaRedditRSS, getStats, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaRedditRSS(`${base}/r/Broadway/search.json?q=Hamilton&limit=100`);
  assert.equal(result.data.children[0].data.id, '1abcxyz');
  assert.equal(getStats().redditRss, 1);
});

test('fetchViaRedditRSS throws on a non-200 response', async () => {
  const { fetchViaRedditRSS, resetFallbackState } = load();
  resetFallbackState();
  await assert.rejects(
    () => fetchViaRedditRSS(`${base}/r/Broadway/blocked.json`),
    /Reddit RSS HTTP 403/
  );
});

test('fetchViaRedditRSS returns an empty listing for a valid feed with no entries (BRO-5916: no-result query is not a failure)', async () => {
  const { fetchViaRedditRSS, resetFallbackState } = load();
  resetFallbackState();
  const resp = await fetchViaRedditRSS(`${base}/r/Broadway/empty.json`);
  assert.deepEqual(resp, { data: { children: [], after: null } });
});

test('fetchViaRedditRSS still throws on a 200 HTML block page', async () => {
  const { fetchViaRedditRSS, resetFallbackState } = load();
  resetFallbackState();
  await assert.rejects(
    () => fetchViaRedditRSS(`${base}/r/Broadway/html.json`),
    /not a parseable Atom feed/
  );
});

test('fetchViaRedditRSS treats a 429 as a rate-limit signal, feeding the shared adaptive backoff', async () => {
  const { fetchViaRedditRSS, getStats, resetFallbackState } = load();
  resetFallbackState();
  process.env.REDDIT_RSS_429_MAX_WAITS = '0'; // no in-call waiting: assert the bare escalation
  const before = getStats().rateLimitCount;
  await assert.rejects(
    () => fetchViaRedditRSS(`${base}/r/Broadway/ratelimited.json`),
    /429/
  );
  assert.equal(getStats().rateLimitCount, before + 1, 'RSS 429 must escalate the same adaptive backoff the JSON path uses');
  assert.equal(getStats().rateLimits, 1);
  delete process.env.REDDIT_RSS_429_MAX_WAITS;
});

test('switchToProxy tries RSS first for a search.json url (opted in) and never touches proxies on success', async () => {
  const { switchToProxy, getStats, resetFallbackState } = load();
  resetFallbackState();
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
  const result = await switchToProxy(`${base}/r/Broadway/search.json?q=Hamilton`, { allowRss: true });
  assert.equal(result.data.children[0].data.id, '1abcxyz');
  assert.equal(getStats().scrapingDog, 0, 'RSS success must not fall through to proxies');
  assert.equal(getStats().scrapingBee, 0);
  assert.equal(getStats().brightData, 0);
});

test('switchToProxy does NOT try RSS on a search.json url without explicit opt-in (searchAllPosts pagination path)', async () => {
  const { switchToProxy, resetFallbackState } = load();
  resetFallbackState();
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
  // No opts (or allowRss:false) — the search.rss mock would succeed if hit,
  // so failing straight to "all proxies unavailable" proves RSS was skipped.
  await assert.rejects(
    () => switchToProxy(`${base}/r/Broadway/search.json?q=Hamilton`),
    /Reddit blocked and all proxies unavailable/
  );
});

test('REDDIT_RSS_DISABLED=1 turns the RSS route off even for opted-in callers (kill switch)', async () => {
  const { switchToProxy, resetFallbackState } = load();
  resetFallbackState();
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
  process.env.REDDIT_RSS_DISABLED = '1';
  try {
    await assert.rejects(
      () => switchToProxy(`${base}/r/Broadway/search.json?q=Hamilton`, { allowRss: true }),
      /Reddit blocked and all proxies unavailable/
    );
  } finally {
    delete process.env.REDDIT_RSS_DISABLED;
  }
});

test('switchToProxy falls through to the proxy chain when RSS fails', async () => {
  const { switchToProxy, resetFallbackState } = load();
  resetFallbackState();
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
  await assert.rejects(
    () => switchToProxy(`${base}/r/Broadway/blocked.json`, { allowRss: true }),
    /Reddit blocked and all proxies unavailable/
  );
});

test('switchToProxy serves a post-comments url from free RSS (BRO-5916), parsed into flattenComments shape', async () => {
  const { switchToProxy, flattenComments, getStats, resetFallbackState } = load();
  resetFallbackState();
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
  commentsRssHit = false;
  const resp = await switchToProxy(`${base}/r/Broadway/comments/1abcxyz.json?limit=500&depth=10&raw_json=1`, { allowRss: true });
  assert.equal(commentsRssHit, true);
  const comments = flattenComments(resp);
  assert.equal(comments.length, 1, 'the post entry (t3_) is dropped, only t1_ comments remain');
  assert.equal(comments[0].id, 'phjg4gy');
  assert.equal(comments[0].author, 'kuomodo_g');
  assert.equal(comments[0].body, 'Wow, so jealous! I love & hear it is good.');
  assert.equal(getStats().redditRss, 1);
});

test('fetchViaRedditRSS waits out a 429 using the rate-limit reset header, then succeeds', async () => {
  const { fetchViaRedditRSS, getStats, resetFallbackState } = load();
  resetFallbackState();
  flakyHits = 0;
  const resp = await fetchViaRedditRSS(`${base}/r/Broadway/flaky.json?q=x`);
  assert.equal(flakyHits, 2);
  assert.equal(resp.data.children.length, 1);
  assert.equal(getStats().rateLimits, 1);
});

test('switchToProxy does NOT use RSS for comments without opt-in (score-ranking callers must not get degraded data)', async () => {
  const { switchToProxy, resetFallbackState } = load();
  resetFallbackState();
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
  commentsRssHit = false;
  await assert.rejects(
    () => switchToProxy(`${base}/r/Broadway/comments/1abcxyz.json`),
    /Reddit blocked and all proxies unavailable/
  );
  assert.equal(commentsRssHit, false);
});

test('toRssUrl maps <id>.json to <id>/.rss for comments and leaves search urls alone', () => {
  const { toRssUrl } = load();
  assert.equal(toRssUrl('https://www.reddit.com/r/B/comments/abc123.json?limit=500&raw_json=1'), 'https://www.reddit.com/r/B/comments/abc123/.rss?limit=25');
  assert.equal(toRssUrl('https://www.reddit.com/r/B/search.json?q=x&raw_json=1'), 'https://www.reddit.com/r/B/search.rss?q=x');
});

// ── BRO-5987: listing / user-submitted routes, line-preserving selftext ─────

const WALTZ_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<author><name>/u/boringwaltz</name></author>
<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;&lt;strong&gt;&lt;em&gt;Hamilton&lt;/em&gt;&lt;/strong&gt;&lt;/p&gt; &lt;p&gt;Estimated Weekly Operating Cost: $850k/week&lt;/p&gt; &lt;p&gt;&lt;strong&gt;&lt;em&gt;Wicked&lt;/em&gt;&lt;/strong&gt;&lt;br/&gt;Estimated Weekly Operating Cost: $1.2m/week&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;&amp;#32; submitted by &amp;#32; &lt;a href="https://www.reddit.com/user/boringwaltz"&gt; /u/boringwaltz &lt;/a&gt; &lt;span&gt;&lt;a href="https://www.reddit.com/r/Broadway/comments/9waltz1/grosses_analysis/"&gt;[12 comments]&lt;/a&gt;&lt;/span&gt;</content>
<id>t3_9waltz1</id>
<link href="https://www.reddit.com/r/Broadway/comments/9waltz1/grosses_analysis/" />
<published>2026-10-19T14:00:00+00:00</published>
<title>Grosses Analysis: Week Ending 10/12</title>
</entry>
</feed>`;

test('isListingUrl / rssEligible: listings and user-submitted opt in; others stay out', () => {
  const { isListingUrl, rssEligible } = load();
  for (const sort of ['hot', 'new', 'rising']) {
    assert.equal(isListingUrl(`https://www.reddit.com/r/Broadway/${sort}.json?limit=50&raw_json=1`), true);
  }
  assert.equal(isListingUrl('https://www.reddit.com/user/boringwaltz/submitted.json?limit=100'), true);
  assert.equal(isListingUrl('https://www.reddit.com/r/Broadway/top/.json'), true);
  assert.equal(isListingUrl('https://www.reddit.com/r/Broadway/about.json'), false);
  assert.equal(rssEligible('https://www.reddit.com/r/Broadway/new.json', { allowRss: true }), true);
  assert.equal(rssEligible('https://www.reddit.com/r/Broadway/new.json', {}), false, 'still opt-in only');
  assert.equal(rssEligible('https://www.reddit.com/r/Broadway/about.json', { allowRss: true }), false);
});

test('toRssUrl maps listings to the <path>/.rss form', () => {
  const { toRssUrl } = load();
  assert.equal(new URL(toRssUrl('https://www.reddit.com/r/Broadway/new.json?limit=50&raw_json=1')).pathname, '/r/Broadway/new/.rss');
  assert.equal(new URL(toRssUrl('https://www.reddit.com/user/boringwaltz/submitted.json?limit=100')).pathname, '/user/boringwaltz/submitted/.rss');
  assert.equal(new URL(toRssUrl('https://www.reddit.com/r/Broadway/top/.json')).pathname, '/r/Broadway/top/.rss');
});

test('user-submitted feed keeps ***Show*** headings and lines for extractCostsFromPost, footer cut', async () => {
  const { fetchViaRedditRSS, resetFallbackState } = load();
  resetFallbackState();
  const srv = http.createServer((req, res) => {
    assert.equal(new URL(req.url, 'http://x').pathname, '/user/boringwaltz/submitted/.rss');
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(WALTZ_FEED);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const json = await fetchViaRedditRSS(`http://127.0.0.1:${srv.address().port}/user/boringwaltz/submitted.json?limit=100`);
    const post = json.data.children[0].data;
    assert.equal(json.data.after, null);
    assert.equal(post._viaRss, true);
    assert.ok(!/submitted by/i.test(post.selftext), `footer must be cut: ${post.selftext}`);
    const require = createRequire(import.meta.url);
    const { extractCostsFromPost } = require('../../scripts/lib/reddit-grosses.js');
    assert.deepEqual(extractCostsFromPost(post.selftext), [
      { showName: 'Hamilton', cost: 850000 },
      { showName: 'Wicked', cost: 1200000 },
    ]);
  } finally {
    srv.close();
  }
});

test('htmlToMarkdownText cuts the real footer (numeric &#32;) but keeps a body line starting "Submitted by"', () => {
  const { htmlToMarkdownText } = load();
  const html = '<div class="md"><p>Submitted by fans: casting rumor</p><p>More&#39;s here</p></div>&#32; submitted by &#32; <a href="x"> /u/foo </a> <span>[link]</span>';
  assert.equal(htmlToMarkdownText(html), "Submitted by fans: casting rumor\nMore's here");
});

test('numeric entities decode, and out-of-range ones are left alone instead of throwing', () => {
  const { parseRedditAtom, htmlToMarkdownText } = load();
  const feed = SAMPLE_FEED.replace('Hamilton &amp; Playbill tickets question', 'Don&#8217;t miss &#x41;');
  assert.equal(parseRedditAtom(feed).data.children[0].data.title, 'Don’t miss A');
  assert.equal(htmlToMarkdownText('<p>a &#99999999; b &#x110000; c</p>'), 'a &#99999999; b &#x110000; c');
});

test('every reddit-api fetchWithFallback caller passes allowRss (BRO-5987 guard)', () => {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  for (const f of ['reddit-engagement-digest.js', 'scrape-cast-changes.js', 'scrape-boring-waltz-costs.js']) {
    const src = fs.readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    const calls = (src.match(/(fetchWithFallback|fetchRedditWithFallback)\([^)]*\)/g) || []).filter((c) => /\burl\b/.test(c));
    assert.ok(calls.length > 0, `${f}: no calls found`);
    for (const c of calls) assert.match(c, /allowRss:\s*true/, `${f}: ${c} must opt into the RSS route`);
  }
});
