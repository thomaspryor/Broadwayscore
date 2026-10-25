import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listingPageUrlReason } = require('./non-review-url-patterns.js');

const FORUM = [
  'https://theatreboard.com/thread/13669/golden-boy-almeida-josh-oconnor?page=11',
  'https://forum.broadwayworld.com/thread/Broadway-GrossesWeek-Ending-6-15-25/2',
  'https://www.balletcoforum.com/topic/12345-some-thread/',
  'https://travelaol.yuku.com/topic/1234/x',
  'https://forums.example.com/thread/9/x',
  'https://foo.proboards.com/thread/5/bar',
];
const REAL = [
  'https://www.britannica.com/topic/Hamlet',
  'https://www.nytimes.com/2026/04/20/theater/schmigadoon-review.html',
  'https://www.broadwayworld.com/article/Review-X-20260101',
];

for (const u of FORUM) test(`forum URL refused: ${u}`, () => assert.equal(listingPageUrlReason(u), 'forum-thread'));
for (const u of REAL) test(`real review URL kept: ${u}`, () => assert.equal(listingPageUrlReason(u), null));

test('guard is wired into create-time writer and read-time exclusion', async () => {
  const fs = await import('node:fs');
  assert.match(fs.readFileSync('scripts/lib/review-file-writer.js', 'utf8'), /listingPageUrlReason/);
  assert.match(fs.readFileSync('scripts/lib/review-guards.js', 'utf8'), /listingPageUrlReason/);
});

test('forum outlets in the registry are marked scoreable:false', async () => {
  const fs = await import('node:fs');
  const r = JSON.parse(fs.readFileSync('data/outlet-registry.json', 'utf8'));
  const o = r.outlets || r;
  const bad = ['theatreboard', 'balletcoforum'].filter((k) => o[k].scoreable !== false);
  assert.deepEqual(bad, []);
});
