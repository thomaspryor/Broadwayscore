import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { searchPlaybillVerdict, VERDICT_CATEGORY_URL, VERDICT_SITEMAP_URL } = require('./playbill-verdict-discover.js');

const show = { id: 'in-the-heights-off-broadway-2026', title: 'In the Heights', slug: 'in-the-heights-off-broadway-2026', category: 'off-broadway' };
const SLUG = 'read-the-reviews-for-in-the-heights';
const SITEMAP = `<urlset><url><loc>https://playbill.com/article/${SLUG}</loc><lastmod>2026-10-29T22:00:00Z</lastmod></url></urlset>`;

function fetcher(map, calls) {
  return async (url) => { calls.push(url); return map[url] || ''; };
}

test('BRO-6682: article missing from category first paint is found via sitemap', async () => {
  const calls = [];
  const hit = await searchPlaybillVerdict(show, {
    fetchHtml: fetcher({ [VERDICT_CATEGORY_URL]: '<html><body>nothing</body></html>', [VERDICT_SITEMAP_URL]: SITEMAP }, calls),
  });
  assert.ok(hit, 'expected sitemap fallback to find the article');
  assert.match(hit.articleUrl, new RegExp(SLUG));
  assert.deepEqual(calls, [VERDICT_CATEGORY_URL, VERDICT_SITEMAP_URL]);
});

test('sitemap is not fetched when the category page already matches', async () => {
  const calls = [];
  const cat = `<a href="https://playbill.com/article/${SLUG}">Reviews: In the Heights</a>`;
  const hit = await searchPlaybillVerdict(show, {
    fetchHtml: fetcher({ [VERDICT_CATEGORY_URL]: cat, [VERDICT_SITEMAP_URL]: SITEMAP }, calls),
  });
  assert.ok(hit);
  assert.deepEqual(calls, [VERDICT_CATEGORY_URL]);
});

test('no match anywhere returns null; skipSitemap suppresses the fallback', async () => {
  const calls = [];
  const other = { ...show, title: 'Hamilton', slug: 'hamilton-broadway-2015', id: 'hamilton-broadway-2015' };
  assert.equal(await searchPlaybillVerdict(other, { fetchHtml: fetcher({ [VERDICT_SITEMAP_URL]: SITEMAP }, calls) }), null);
  const c2 = [];
  assert.equal(await searchPlaybillVerdict(show, { skipSitemap: true, fetchHtml: fetcher({ [VERDICT_SITEMAP_URL]: SITEMAP }, c2) }), null);
  assert.deepEqual(c2, [VERDICT_CATEGORY_URL]);
});

test('sitemap fetched once per fetcher across shows (cache)', async () => {
  const calls = [];
  const f = fetcher({ [VERDICT_SITEMAP_URL]: SITEMAP }, calls);
  await searchPlaybillVerdict({ ...show, title: 'Zzz Unmatched', slug: 'zzz', id: 'zzz' }, { fetchHtml: f });
  await searchPlaybillVerdict(show, { fetchHtml: f });
  assert.equal(calls.filter((u) => u === VERDICT_SITEMAP_URL).length, 1);
});

test('throwing sitemap fetch yields null, not an error', async () => {
  const f = async (u) => { if (u === VERDICT_SITEMAP_URL) throw new Error('boom'); return ''; };
  assert.equal(await searchPlaybillVerdict(show, { fetchHtml: f }), null);
});
