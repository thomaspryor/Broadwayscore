// BRO-2410: every real post uses `show:` (title), not `showSlug:`; the generator
// silently produced 0 entries when it required showSlug. Guard against regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { resolveShowId } = require('./lib/resolve-blog-show-id.js');
const { normalizeTitle } = require('./lib/title-match.js');

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

test('generator emits entries for show:-only posts (no showSlug) and skips unresolvable ones', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-scoring-'));
  const dir = path.join(tmp, 'reviews');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'edward.md'), '---\ntitle: "x"\nshow: "Edward"\nscore: 84\npublishDate: "2026-03-01"\n---\nbody\n');
  fs.writeFileSync(path.join(dir, 'ghost.md'), '---\ntitle: "y"\nshow: "No Such Show"\nscore: 70\n---\nbody\n');
  fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify({ shows }));
  const out = path.join(tmp, 'out.json');
  execFileSync('node', [path.join(__dirname, 'generate-blog-reviews-for-scoring.js')], {
    stdio: 'pipe',
    env: { ...process.env, BLOG_REVIEWS_DIR: dir, BLOG_SHOWS_PATH: path.join(tmp, 'shows.json'), BLOG_OUTPUT_PATH: out },
  });
  const { reviews } = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].showId, 'edward-2026');
  assert.equal(reviews[0].assignedScore, 84);
  fs.rmSync(tmp, { recursive: true, force: true });
});
