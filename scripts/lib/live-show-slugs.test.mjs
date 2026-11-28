import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractShowSlugs } = require('./live-show-slugs.js');

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://broadwayscorecard.com</loc></url>
<url><loc>https://broadwayscorecard.com/guides/best-broadway-shows</loc></url>
<url><loc>https://broadwayscorecard.com/show/hamilton</loc></url>
<url><loc>https://broadwayscorecard.com/show/the-lost-boys</loc></url>
</urlset>`;

test('extractShowSlugs pulls only /show/ slugs, ignoring other routes', () => {
  const slugs = extractShowSlugs(SAMPLE_XML);
  assert.deepEqual(slugs, ['hamilton', 'the-lost-boys']);
});

test('extractShowSlugs returns an empty array for non-show sitemaps', () => {
  const xml = `<urlset><url><loc>https://broadwayscorecard.com/west-end</loc></url></urlset>`;
  assert.deepEqual(extractShowSlugs(xml), []);
});

test('extractShowSlugs handles empty/invalid input', () => {
  assert.deepEqual(extractShowSlugs(''), []);
  assert.deepEqual(extractShowSlugs(null), []);
  assert.deepEqual(extractShowSlugs(undefined), []);
});
