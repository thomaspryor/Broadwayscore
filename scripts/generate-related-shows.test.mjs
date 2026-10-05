// BRO-2408: generate-related-shows.js must score from loadReviewsWithBlog(),
// not a raw data/reviews.json read (BRO-339 drift class).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'generate-related-shows.js'), 'utf-8');
const { buildScoreMap } = require('./lib/related-shows-scores.js');

test('script sources reviews via loadReviewsWithBlog and feeds them to buildScoreMap', () => {
  assert.match(src, /require\('\.\/lib\/load-reviews-with-blog'\)/);
  assert.match(src, /const reviews = loadReviewsWithBlog\(\)/);
  assert.match(src, /buildScoreMap\(reviews,/);
});

test('script does not read data/reviews.json directly', () => {
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /reviews\.json/);
  assert.doesNotMatch(code, /JSON\.parse\([^)]*reviews/);
});

test('a show whose only scores come from blog rows still gets a score', () => {
  const blogOnly = [70, 75, 80, 65, 72].map(assignedScore => ({ showId: 'blog-only', assignedScore }));
  assert.equal(buildScoreMap([], [{ id: 'blog-only' }]).has('blog-only'), false);
  assert.equal(buildScoreMap(blogOnly, [{ id: 'blog-only' }]).get('blog-only'), 72);
});
