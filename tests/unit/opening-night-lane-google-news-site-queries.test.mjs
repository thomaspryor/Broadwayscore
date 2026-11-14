import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { googleNewsSiteQueries, googleNewsAdapter } = require('../../scripts/lib/opening-night-lane/discovery.js');

// BRO-7044: `"2:22 - A Ghost Story" site:nysun.com` is an exact phrase with a hyphen the Sun's headline
// ('2:22 — A Ghost Story': Not Quite a Screaming Good Time) does not have, so Google returned only the Sun's general news.
test('site query keeps the old form and adds a dash-free outlet-named query', () => {
  const q = googleNewsSiteQueries({ title: '2:22 - A Ghost Story' }, 'nysun.com');
  assert.deepEqual(q, ['"2:22 - A Ghost Story" site:nysun.com', '"2:22 A Ghost Story" nysun']);
});
test('a title with no dash punctuation gets only the site query (no duplicate)', () => {
  const q = googleNewsSiteQueries({ title: 'The Unbelievers' }, 'www.nysun.com');
  assert.deepEqual(q, ['"The Unbelievers" site:www.nysun.com']);
});

test('adapter: the dash-free query is actually fetched and its Sun item is kept', async () => {
  const asked = [];
  const sunItem = `<item><title>‘2:22 — A Ghost Story’: Not Quite a Screaming Good Time - The New York Sun</title><link>https://news.google.com/rss/articles/CBMiXXXX</link><pubDate>Fri, 06 Nov 2026 00:00:00 GMT</pubDate><source url="https://www.nysun.com">The New York Sun</source></item>`;
  const fetchText = async (url) => {
    const q = new URL(url).searchParams.get('q');
    asked.push(q);
    return q === '"2:22 A Ghost Story" nysun' ? `<rss><channel>${sunItem}</channel></rss>` : '<rss><channel></channel></rss>';
  };
  const adapter = googleNewsAdapter({ decodeImpl: async () => 'https://www.nysun.com/article/222-a-ghost-story-not-quite-a-screaming-good-time', log: () => {} });
  const out = await adapter.discover({ show: { id: '222-a-ghost-story-off-broadway-2026', title: '2:22 - A Ghost Story', category: 'off-broadway' }, fetchText, night: null });
  assert.ok(asked.includes('"2:22 A Ghost Story" nysun'), `asked ${JSON.stringify(asked)}`);
  const urls = (Array.isArray(out) ? out : (out.candidates || out.items || [])).map((c) => c.url || c.link);
  assert.ok(urls.some((u) => /nysun\.com\/article\/222-a-ghost-story/.test(u)), `got ${JSON.stringify(out).slice(0, 400)}`);
});

test('BRO-7044: no duplicate loose query when the title has no dash', async () => {
  const { createRequire } = await import('node:module');
  const { googleNewsSiteQueries } = createRequire(import.meta.url)('../../scripts/lib/opening-night-lane/discovery.js');
  assert.equal(googleNewsSiteQueries({ title: 'The Unbelievers' }, 'nysun.com').length, 1);
});
