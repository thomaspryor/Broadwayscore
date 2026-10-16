import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { extractArticlesFromSitemap } = require('./playbill-verdict-discover');

const xml = (lastmod) => `<urlset><url><loc>https://playbill.com/article/reviews-what-do-the-critics-think-of-new-manga-musical-memoirs-of-amorous-gentlemen</loc><lastmod>${lastmod}</lastmod></url></urlset>`;

test('sitemap lastmod in UTC after midnight is the previous New York day (BRO-5499)', () => {
  assert.equal(extractArticlesFromSitemap(xml('2026-10-16T03:45:00+00:00'))[0].publishDate, '2026-10-15');
});
test('daytime lastmod and date-only lastmod keep their date', () => {
  assert.equal(extractArticlesFromSitemap(xml('2026-10-16T14:10:00+00:00'))[0].publishDate, '2026-10-16');
  assert.equal(extractArticlesFromSitemap(xml('2026-10-16'))[0].publishDate, '2026-10-16');
});
