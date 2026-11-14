import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSitemapLines } = require('./sitemap-urls.js');

test('extracts every Sitemap: line in order', () => {
  const robots = [
    'User-Agent: *',
    'Allow: /',
    'Disallow: /admin/',
    'Sitemap: https://broadwayscorecard.com/sitemap/0.xml',
    'Sitemap: https://broadwayscorecard.com/sitemap/1.xml',
    'Sitemap: https://broadwayscorecard.com/sitemap/2.xml',
  ].join('\n');
  assert.deepEqual(parseSitemapLines(robots), [
    'https://broadwayscorecard.com/sitemap/0.xml',
    'https://broadwayscorecard.com/sitemap/1.xml',
    'https://broadwayscorecard.com/sitemap/2.xml',
  ]);
});

test('is case-insensitive and tolerates extra whitespace', () => {
  const robots = 'sitemap:   https://x.com/sitemap/0.xml\nSITEMAP:\thttps://x.com/sitemap/1.xml';
  assert.deepEqual(parseSitemapLines(robots), [
    'https://x.com/sitemap/0.xml',
    'https://x.com/sitemap/1.xml',
  ]);
});

test('returns [] when there are no Sitemap lines', () => {
  assert.deepEqual(parseSitemapLines('User-Agent: *\nDisallow: /admin/'), []);
});

test('does not match a URL that merely contains the word sitemap', () => {
  // "Disallow: /sitemap-preview" is not a Sitemap directive.
  assert.deepEqual(parseSitemapLines('Disallow: /sitemap-preview\n'), []);
});

test('handles empty / non-string input safely', () => {
  assert.deepEqual(parseSitemapLines(''), []);
  assert.deepEqual(parseSitemapLines(null), []);
  assert.deepEqual(parseSitemapLines(undefined), []);
});
