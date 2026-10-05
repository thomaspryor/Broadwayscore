// BRO-2410: every real post uses `show:` (title), not `showSlug:`; the generator
// silently produced 0 entries when it required showSlug. Guard against regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { resolveShowId } = require('./lib/resolve-blog-show-id.js');
const { normalizeTitle } = require('./lib/title-match.js');
const matter = require('gray-matter');

const shows = [
  { id: 'edward-2026', slug: 'edward', title: 'Edward' },
  { id: 'cats-1982', slug: 'cats-1982', title: 'Cats', venue: 'Winter Garden Theatre', previewsStartDate: '1982-09-01', openingDate: '1982-10-07', closingDate: '2000-09-10' },
  { id: 'cats-2026', slug: 'cats-2026', title: 'Cats', venue: 'Broadhurst Theatre', previewsStartDate: '2026-02-01', openingDate: '2026-04-01' },
];
const slugToId = new Map(shows.map(s => [s.slug, s.id]));
const byTitle = new Map();
for (const s of shows) {
  const k = normalizeTitle(s.title);
  if (!byTitle.has(k)) byTitle.set(k, []);
  byTitle.get(k).push(s);
}
const r = (data) => resolveShowId(data, 't.md', slugToId, byTitle);

test('show: title (no showSlug) resolves', () => {
  assert.equal(r({ show: 'Edward' }), 'edward-2026');
});
test('showSlug takes priority', () => {
  assert.equal(r({ showSlug: 'edward', show: 'Cats' }), 'edward-2026');
});
test('unknown showSlug / missing both -> null', () => {
  assert.equal(r({ showSlug: 'nope' }), null);
  assert.equal(r({}), null);
});
test('same-title shows disambiguated by venue and by date', () => {
  assert.equal(r({ show: 'Cats', venue: 'Broadhurst Theatre' }), 'cats-2026');
  assert.equal(r({ show: 'Cats', dateAttended: new Date('2026-03-21') }), 'cats-2026');
});
test('ambiguous -> null', () => {
  assert.equal(r({ show: 'Cats' }), null);
});

test('real content/reviews posts with show: yield non-empty output', () => {
  const dir = path.join(process.cwd(), 'content/reviews');
  const posts = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  assert.ok(posts.length > 0);
  assert.ok(posts.some(f => !matter(fs.readFileSync(path.join(dir, f), 'utf8')).data.showSlug),
    'expected real posts using show: rather than showSlug:');
  const out = path.join(process.cwd(), 'data/blog-reviews-for-scoring.json');
  const before = fs.readFileSync(out, 'utf8');
  try {
    execFileSync('node', ['scripts/generate-blog-reviews-for-scoring.js'], { stdio: 'pipe' });
    const { reviews } = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(reviews.length > 0, 'generator produced 0 entries');
  } finally {
    fs.writeFileSync(out, before);
  }
});
