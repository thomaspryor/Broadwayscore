// TESTS-VS-DERIVED-DATA-EXEMPT: URL parity against hashes of the actual image bytes, with no factual data pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { buildSiteImageVersions, writeSiteImageVersions } = require('../../scripts/lib/site-image-versions.js');
writeSiteImageVersions();
require('tsx/cjs/api').register();
const { versionedImagePath } = require('../../scripts/lib/versioned-image-path.js');
const { getAllShows } = require('../../src/lib/data-core.ts');
const rawShows = require('../../data/shows.json').shows;

test('manifest reuses feed hashes and changes only the art that was replaced', t => {
  const publicDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-site-image-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(publicDir, 'images/shows/test'), { recursive: true });
  fs.mkdirSync(path.join(publicDir, 'images/theaters'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'images/shows/test/poster.jpg'), 'old art');
  fs.writeFileSync(path.join(publicDir, 'images/theaters/test.jpg'), 'theater photo');
  fs.writeFileSync(path.join(publicDir, 'unrelated.txt'), 'not an image');
  const before = buildSiteImageVersions(publicDir);
  assert.equal(Object.keys(before).length, 2);
  assert.equal(before['/images/shows/test/poster.jpg'], versionedImagePath('/images/shows/test/poster.jpg', publicDir));
  assert.deepEqual(buildSiteImageVersions(publicDir), before, 'unchanged bytes keep their URLs');
  fs.writeFileSync(path.join(publicDir, 'images/shows/test/poster.jpg'), 'replacement artwork');
  const after = buildSiteImageVersions(publicDir);
  assert.notEqual(after['/images/shows/test/poster.jpg'], before['/images/shows/test/poster.jpg']);
  assert.equal(after['/images/theaters/test.jpg'], before['/images/theaters/test.jpg']);
  fs.rmSync(path.join(publicDir, 'images/shows/test/poster.jpg'));
  assert.equal(buildSiteImageVersions(publicDir)['/images/shows/test/poster.jpg'], undefined);
  assert.deepEqual(buildSiteImageVersions(path.join(publicDir, 'missing')), {});
});

test('server helper preserves external, missing, queried and empty paths', () => {
  const { versionedImagePath: sitePath } = require('../../src/lib/versioned-image-path.ts');
  for (const p of ['https://cdn.example.com/a.jpg', '/images/missing.jpg', '/images/x.jpg?v=old', '/images/../x.jpg', '/other/a.jpg', 'toString', '', null, undefined]) {
    assert.equal(sitePath(p), p);
  }
  const manifest = require('../../data/site-image-versions.json');
  for (const directory of ['/images/shows/', '/images/theaters/', '/images/fantasy/']) {
    const p = Object.keys(manifest).find(p => p.startsWith(directory));
    assert.ok(p, `${directory} art exists`);
    assert.equal(sitePath(p), versionedImagePath(p));
    assert.equal(sitePath(sitePath(p)), sitePath(p), 'already-versioned URLs are stable');
  }
});

test('site show data versions existing art before passing it to pages and clients', () => {
  const originalImages = JSON.stringify(rawShows.map(show => show.images));
  const byId = new Map(getAllShows().map(show => [show.id, show]));
  let checked = 0;
  for (const raw of rawShows) {
    const show = byId.get(raw.id);
    if (!show) continue;
    for (const key of ['thumbnail', 'poster', 'hero']) {
      const original = raw.images?.[key];
      if (!original) continue;
      const expected = versionedImagePath(original);
      assert.equal(show.images?.[key], expected, `${raw.id} ${key}`);
      if (expected !== original) checked++;
    }
  }
  assert.ok(checked > 0, 'real show images must be available');
  assert.equal(JSON.stringify(rawShows.map(show => show.images)), originalImages, 'raw data is unchanged');
});

test('server regeneration uses the shipped manifest without public image files', t => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-site-image-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'data'));
  const p = Object.keys(require('../../data/site-image-versions.json')).find(p => p.startsWith('/images/theaters/'));
  assert.ok(p, 'a real theater image exists');
  fs.writeFileSync(path.join(dir, 'data/site-image-versions.json'), JSON.stringify({ [p]: versionedImagePath(p) }));
  const helper = path.resolve('src/lib/versioned-image-path.ts');
  const register = require.resolve('tsx/cjs');
  const output = execFileSync(process.execPath, ['--require', register, '-e',
    `console.log(require(${JSON.stringify(helper)}).versionedImagePath(${JSON.stringify(p)}))`,
  ], { cwd: dir, encoding: 'utf8' });
  assert.equal(output.trim(), versionedImagePath(p));
  assert.equal(fs.existsSync(path.join(dir, 'public')), false);
});

test('critic and video profiles version art from their independent raw-show loaders', () => {
  const rawById = new Map(rawShows.map(show => [show.id, show]));
  const rawBySlug = new Map(rawShows.map(show => [show.slug, show]));
  const { getAllCritics } = require('../../src/lib/data-reviews.ts');
  let checked = 0;
  for (const critic of getAllCritics()) {
    for (const review of critic.reviews) {
      const p = rawBySlug.get(review.showSlug)?.images?.thumbnail || null;
      assert.equal(review.showThumbnail, versionedImagePath(p), review.showSlug);
      if (p) checked++;
    }
  }
  assert.ok(checked > 0, 'real critic reviews were checked');
  const { getAllVideoCreators } = require('../../src/lib/data-video-critics.ts');
  for (const creator of getAllVideoCreators()) {
    for (const review of creator.reviews) {
      const images = rawById.get(review.showId)?.images;
      assert.equal(review.showThumbnail, versionedImagePath(images?.poster || images?.thumbnail || null));
    }
  }
});

test('Next builds and traces the manifest; theater and icon producers use the server helper', () => {
  const config = require('../../next.config.js');
  assert.ok(config.outputFileTracingIncludes['**/*'].includes('data/site-image-versions.json'));
  for (const file of ['src/app/theater/page.tsx', 'src/app/theater/[slug]/page.tsx']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /return versionedImagePath\(`\/images\/theaters\/\$\{slug\}\.jpg`\)/);
    assert.match(source, /import \{ versionedImagePath \} from '@\/lib\/versioned-image-path'/);
  }
  const icons = fs.readFileSync('src/app/fantasy/layout.tsx', 'utf8');
  assert.equal((icons.match(/versionedImagePath\('\/images\/fantasy\//g) || []).length, 3);
});
