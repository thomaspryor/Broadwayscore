import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('./newsletter-sources.js');

const INDEX = `<a href="/blog/composite-october-4-2026">a</a><a href="/blog/composite-september-27-2026">b</a>
<a href="https://chromolume.io/blog/composite-october-4-2026/">dup</a><a href="/blog/composite-smarch-3-2026">bad month</a><a href="/blog/other-post">x</a>`;

test('parseChromolumeIndex: composite posts only, deduped, newest first, date from slug', () => {
  assert.deepEqual(src.parseChromolumeIndex(INDEX), [
    { url: 'https://chromolume.io/blog/composite-october-4-2026', date: '2026-10-04' },
    { url: 'https://chromolume.io/blog/composite-september-27-2026', date: '2026-09-27' },
  ]);
  assert.deepEqual(src.parseChromolumeIndex(''), []);
});

const FEED = `<rss><channel><item><title><![CDATA[Older &amp; wiser]]></title><link>https://gordoncox.substack.com/p/older</link><pubDate>Thu, 08 Oct 2026 12:59:39 GMT</pubDate><content:encoded><![CDATA[<p>Hello <a href="https://x.example/a">there</a></p>]]></content:encoded></item>
<item><title>Newer</title><link>https://gordoncox.substack.com/p/newer</link><pubDate>Wed, 21 Oct 2026 12:42:41 GMT</pubDate><description>Plain desc</description></item></channel></rss>`;

test('parseFeedItems: newest first, CDATA and HTML decoded, description fallback', () => {
  const items = src.parseFeedItems(FEED);
  assert.deepEqual(items.map((i) => i.url), ['https://gordoncox.substack.com/p/newer', 'https://gordoncox.substack.com/p/older']);
  assert.equal(items[0].date, '2026-10-21');
  assert.equal(items[0].text, 'Plain desc');
  assert.equal(items[1].text, 'Hello there (https://x.example/a)');
  assert.equal(items[1].title, 'Older & wiser');
});

test('htmlToText drops scripts, nav and entities but keeps link targets', () => {
  const t = src.htmlToText('<nav>menu</nav><script>var a=1</script><p>HAMILTON&rsquo;s &mdash; best&nbsp;week <a href="https://a.example/x">link</a></p>');
  assert.equal(t, "HAMILTON's - best week link (https://a.example/x)");
});

test('splitBriefingItems keeps only bway.ly links near money or closing words', () => {
  const html = '<p>THE SHOW closes Sunday after raising $20 million <a href="https://bway.ly/AAA111?utm=x">story</a></p>' + '<p>' + 'filler '.repeat(200) + '</p>' +
    '<p>Photos from the party <a href="https://bway.ly/BBB222">photos</a></p><a href="https://other.example/x">no</a>';
  const r = src.splitBriefingItems(html, '');
  assert.equal(r.linksFound, 2);
  assert.deepEqual(r.candidates.map((c) => c.link), ['https://bway.ly/AAA111']);
});

test('stripTracking removes utm and click ids, keeps real query params', () => {
  assert.equal(src.stripTracking(new URL('https://a.com/x?p=7&utm_source=sniply&fbclid=1#frag')), 'https://a.com/x?p=7');
});

const resp = (status, headers = {}, body = '', url = '') => ({ status, ok: status >= 200 && status < 300, url, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => body });
const registered = (u) => (/(^|\.)broadwaynews\.com$/.test(new URL(u).hostname) ? { outletId: 'broadwaynews' } : null);

test('resolveBwayLink: reads the 302 Location without following it and strips tracking', async () => {
  const calls = [];
  const fetchImpl = async (u, o) => { calls.push([u, o.redirect]); return resp(302, { location: 'https://www.broadwaynews.com/a-story/?utm_source=sniply&utm_medium=sniply' }); };
  const r = await src.resolveBwayLink('https://bway.ly/kkww9m', { fetchImpl, resolveOutlet: registered });
  assert.deepEqual(r, { ok: true, url: 'https://www.broadwaynews.com/a-story/' });
  assert.deepEqual(calls, [['https://bway.ly/kkww9m', 'manual']]);
});

test('resolveBwayLink: rejects other hosts, non-outlets, http, internal addresses and non-redirects', async () => {
  const go = (link, location, status = 302) => src.resolveBwayLink(link, { fetchImpl: async () => resp(status, { location }), resolveOutlet: registered });
  assert.equal((await go('https://evil.example/x', 'https://www.broadwaynews.com/a')).reason, 'not-bway-ly');
  assert.equal((await go('https://bway.ly.evil.example/x', 'https://www.broadwaynews.com/a')).reason, 'not-bway-ly');
  assert.equal((await go('https://bway.ly/x', 'https://random-blog.example/a')).reason, 'destination-not-registered-outlet');
  assert.equal((await go('https://bway.ly/x', 'http://169.254.169.254/latest')).reason, 'destination-not-https');
  assert.equal((await go('https://bway.ly/x', 'https://127.0.0.1/a')).reason, 'destination-not-registered-outlet');
  assert.equal((await go('https://bway.ly/x', '', 200)).reason, 'link-did-not-redirect');
  const down = await src.resolveBwayLink('https://bway.ly/x', { fetchImpl: async () => { throw new Error('boom'); }, resolveOutlet: registered });
  assert.equal(down.reason, 'link-unreachable');
});

test('fetchPublicText: allowlist on request and final URL, paywall codes, size and type', async () => {
  const allow = (u) => u.startsWith('https://ok.example/');
  const ok = await src.fetchPublicText('https://ok.example/a', { fetchImpl: async () => resp(200, { 'content-type': 'text/html' }, '<p>hi</p>', 'https://ok.example/a'), isAllowed: allow });
  assert.deepEqual(ok, { ok: true, body: '<p>hi</p>' });
  assert.equal((await src.fetchPublicText('https://evil.example/a', { fetchImpl: async () => { throw new Error('must not fetch'); }, isAllowed: allow })).reason, 'host-not-allowed');
  assert.equal((await src.fetchPublicText('https://ok.example/a', { fetchImpl: async () => resp(200, {}, 'x', 'https://evil.example/b'), isAllowed: allow })).reason, 'redirected-off-allowlist');
  assert.equal((await src.fetchPublicText('https://ok.example/a', { fetchImpl: async () => resp(403, {}, '', 'https://ok.example/a'), isAllowed: allow })).reason, 'fetch-blocked');
  assert.equal((await src.fetchPublicText('https://ok.example/a', { fetchImpl: async () => resp(500, {}, '', 'https://ok.example/a'), isAllowed: allow })).reason, 'http-500');
  assert.equal((await src.fetchPublicText('https://ok.example/a', { fetchImpl: async () => resp(200, { 'content-type': 'application/pdf' }, '', 'https://ok.example/a'), isAllowed: allow })).reason, 'not-html');
});

test('pickPosts: live runs skip processed posts, dry runs always take the newest', () => {
  const listing = [{ url: 'c' }, { url: 'b' }, { url: 'a' }];
  assert.deepEqual(src.pickPosts(listing, ['c'], { maxNew: 1, dryRun: false }), { toRead: [{ url: 'b' }], unreadOlder: 1 });
  assert.deepEqual(src.pickPosts(listing, ['c'], { maxNew: 2, dryRun: true }).toRead.map((p) => p.url), ['c', 'b']);
});

// ---- skip-ratio alert threshold (BRO-6265 PREVENTION) ----
const per = (over = {}) => ({ briefing: { label: 'Briefing', found: 7, read: 7, skipped: {}, listingEmpty: false }, ...over });

test('evaluateSkipHealth: no alert when everything is read', () => {
  const r = src.evaluateSkipHealth(per());
  assert.deepEqual(r.alerts, []);
  assert.deepEqual(r.zeroRuns, { briefing: 0 });
});

test('evaluateSkipHealth: exactly half skipped is quiet, more than half alerts (the 6-of-7 regression)', () => {
  const half = src.evaluateSkipHealth(per({ briefing: { label: 'Briefing', found: 4, read: 2, skipped: { x: 2 } } }));
  assert.equal(half.alerts.length, 0);
  const bad = src.evaluateSkipHealth(per({ briefing: { label: 'Briefing', found: 7, read: 1, skipped: { 'issue-has-no-public-url': 6 } } }));
  assert.equal(bad.alerts.length, 1);
  assert.equal(bad.alerts[0].conditionKey, 'theater-newsletter-skip-ratio:briefing');
  assert.match(bad.alerts[0].title, /skipped 6 of 7/);
  assert.match(bad.alerts[0].description, /issue-has-no-public-url x6/);
  assert.equal(bad.alerts[0].disposition, 'auto');
  assert.equal(bad.alerts[0].severity, 'warning');
});

test('evaluateSkipHealth: out-of-window and foreign-sender skips do not count toward the ratio reasons', () => {
  const r = src.evaluateSkipHealth(per({ briefing: { label: 'Briefing', found: 3, read: 3, skipped: { 'older-than-window': 5 } } }));
  assert.equal(r.alerts.length, 0);
});

test('evaluateSkipHealth: zero readable two runs in a row alerts, one run does not, a good run resets', () => {
  const zero = per({ chromolume: { label: 'Chromolume', found: 0, read: 0, skipped: {}, listingEmpty: true } });
  const first = src.evaluateSkipHealth(zero, {});
  assert.equal(first.alerts.length, 0);
  assert.equal(first.zeroRuns.chromolume, 1);
  const second = src.evaluateSkipHealth(zero, first.zeroRuns);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].conditionKey, 'theater-newsletter-zero-readable:chromolume');
  const reset = src.evaluateSkipHealth(per({ chromolume: { label: 'Chromolume', found: 1, read: 1, skipped: {} } }), second.zeroRuns);
  assert.equal(reset.zeroRuns.chromolume, 0);
});

test('evaluateSkipHealth: a quiet week with no new posts is not a zero-readable run', () => {
  const r = src.evaluateSkipHealth(per({ abroadway: { label: 'Abroad/Way', found: 0, read: 0, skipped: {}, listingEmpty: false } }), { abroadway: 5 });
  assert.equal(r.zeroRuns.abroadway, 0);
  assert.equal(r.alerts.length, 0);
});

test('fetchPublicText: checks every redirect hop before requesting it', async () => {
  const allow = (u) => u.startsWith('https://ok.example/');
  const seen = [];
  const hop = async (u) => { seen.push(u); return u.endsWith('/a') ? resp(302, { location: 'http://169.254.169.254/x' }, '', u) : resp(200, { 'content-type': 'text/html' }, 'x', u); };
  assert.equal((await src.fetchPublicText('https://ok.example/a', { fetchImpl: hop, isAllowed: allow })).reason, 'redirected-off-allowlist');
  assert.deepEqual(seen, ['https://ok.example/a']);
  const ok = await src.fetchPublicText('https://ok.example/b', { fetchImpl: async (u) => (u.endsWith('/b') ? resp(301, { location: '/c' }, '', u) : resp(200, { 'content-type': 'text/html' }, 'done', u)), isAllowed: allow });
  assert.deepEqual(ok, { ok: true, body: 'done' });
});

test('parseArchiveJson: public posts only, newest first; postBodyFromJson reads body_html', () => {
  const raw = JSON.stringify([
    { slug: 'old', canonical_url: 'https://gordoncox.substack.com/p/old', title: 'Old', post_date: '2026-10-08T12:00:00.000Z', audience: 'everyone' },
    { slug: 'paid', canonical_url: 'https://gordoncox.substack.com/p/paid', title: 'Paid', post_date: '2026-10-25T12:00:00.000Z', audience: 'only_paid' },
    { slug: 'new', canonical_url: 'https://gordoncox.substack.com/p/new', title: 'New', post_date: '2026-10-21T12:00:00.000Z', audience: 'everyone' },
  ]);
  assert.deepEqual(src.parseArchiveJson(raw).map((p) => p.slug), ['new', 'old']);
  assert.deepEqual(src.parseArchiveJson('not json'), []);
  assert.equal(src.postBodyFromJson(JSON.stringify({ body_html: '<p>Hello &amp; welcome</p>' })), 'Hello & welcome');
  assert.equal(src.postBodyFromJson('{}'), '');
});
