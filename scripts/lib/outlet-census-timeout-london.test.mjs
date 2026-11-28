// BRO-8348: Time Out London files some press-night reviews as news
// (/london/news/<slug>-review-<slug>-<id>); the census sitemap filter must list them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LONDON_SOURCES } = require('./outlet-census-sources.js');

test('timeout-london census filter matches /london/news/ review URLs and not other news', () => {
  const src = LONDON_SOURCES['timeout-london'];
  assert.ok(src && src.urlFilter, 'timeout-london source with urlFilter');
  const f = src.urlFilter;
  assert.ok(f.test('https://www.timeout.com/london/theatre/the-bridge-4-review'));
  assert.ok(f.test('https://www.timeout.com/london/news/the-lives-of-others-review-keira-knightley-stars-in-a-west-end-adaptation-of-the-east-german-thriller-110326'));
  assert.ok(!f.test('https://www.timeout.com/london/news/keira-knightley-will-return-to-the-london-stage-to-star-in-a-west-end-adaptation-of-award-winning-film-the-lives-of-others-042926'));
  assert.ok(!f.test('https://www.timeout.com/london/news/best-theatre-reviews-of-the-year-123'));
  assert.ok(!f.test('https://www.timeout.com/london/things-to-do/halloween-between-the-bridges'));
});
