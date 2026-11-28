import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reviewPostsForShow, WP_SEARCH_SOURCES } = require('../../scripts/lib/outlet-ground-truth');
const tm = WP_SEARCH_SOURCES.find(s => s.id === 'theatermania');
const show = { id: 'king-lear', title: 'King Lear' };
const post = (name, title, excerpt) => ({ link: `https://www.theatermania.com/news/review-${name}/`, title: { rendered: title }, excerpt: { rendered: excerpt } });
test('TheaterMania search results do not match a show only mentioned in an excerpt or tags', () => {
  const posts = [
    post('anon', 'Review: Anon', '<p>Anne Washburn’s play opens at MCC. ||Off-Broadway|Anne Washburn,King Lear,MCC Theater</p>'),
    post('chinese-republicans', 'Review: Chinese Republicans', '<p>A follow-up to Laowang: A Chinatown King Lear.</p>'),
    post('king-lear', 'Review: King Lear at La MaMa', '<p>A production at La MaMa.</p>'),
  ];
  assert.deepEqual(reviewPostsForShow(posts, show, tm).map(p => p.headline), ['Review: King Lear at La MaMa']);
});
