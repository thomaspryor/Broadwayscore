import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findImagePointerProblems, imagePointerSeverity } = require('./image-pointers');
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-pointers-'));
after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
fs.mkdirSync(path.join(publicDir, 'images', 'shows', 'show'), { recursive: true });
fs.writeFileSync(path.join(publicDir, 'images', 'shows', 'show', 'poster.jpg'), 'image');
fs.writeFileSync(path.join(publicDir, 'outside.jpg'), 'image');
const poster = '/images/shows/show/poster.jpg';
const options = { publicDir, remotePatterns: [{ protocol: 'https', hostname: 'images.ctfassets.net', pathname: '/our-space/**' }] };
const check = images => findImagePointerProblems([{ id: 'show', images }], options);

test('existing local files, including query strings, and null pointers pass', () => {
  assert.deepEqual(check({ hero: null, poster }), []);
  assert.deepEqual(check({ hero: `${poster}?v=2`, poster: undefined }), []);
  assert.deepEqual(findImagePointerProblems([{ id: 'empty' }], options), []);
});

test('a missing hero fails even when its poster exists (Ford Hill)', () => {
  assert.deepEqual(check({ hero: '/images/shows/show/hero.webp', poster }), [{
    id: 'show', key: 'hero', value: '/images/shows/show/hero.webp', reason: 'local image file does not exist',
  }]);
});

test('a missing jpg fails even if a webp sibling exists', () => {
  fs.writeFileSync(path.join(publicDir, 'images', 'shows', 'show', 'hero.webp'), 'image');
  assert.equal(check({ hero: '/images/shows/show/hero.jpg' }).length, 1);
});

test('remote patterns enforce protocol, host, and tenant path', () => {
  assert.deepEqual(check({ hero: 'https://images.ctfassets.net/our-space/hero.jpg' }), []);
  for (const hero of ['https://images.ctfassets.net/another-space/hero.jpg', 'http://images.ctfassets.net/our-space/hero.jpg', 'https://unlisted.example/hero.jpg', '//images.ctfassets.net/our-space/hero.jpg']) {
    assert.equal(check({ hero }).length, 1, hero);
  }
});

test('malformed pointers, directories, and paths outside public/images fail', () => {
  for (const hero of ['', ' ', 123, 'relative.jpg', '/outside.jpg', '/images/../outside.jpg', '/images/%2e%2e/outside.jpg', '/images/shows/show', '/images/%zz']) {
    assert.equal(check({ hero }).length, 1, String(hero));
  }
});

test('only hero/poster are validated and input records are unchanged', () => {
  const shows = [{ id: 'show', images: { hero: poster, poster, thumbnail: '/images/missing.jpg' } }];
  const before = JSON.stringify(shows);
  assert.deepEqual(findImagePointerProblems(shows, options), []);
  assert.equal(JSON.stringify(shows), before);
});

test('an existing missing historical poster warns, but a new broken pointer errors', () => {
  const id = 'the-violet-hour-2003';
  const poster = `/images/shows/${id}/poster.jpg`;
  const [known] = findImagePointerProblems([{ id, images: { poster } }], options);
  assert.equal(imagePointerSeverity(known), 'warn');
  const [newShow] = findImagePointerProblems([{ id: 'new-show', images: { poster } }], options);
  assert.equal(imagePointerSeverity(newShow), 'error');
  const [changedPointer] = findImagePointerProblems([{ id, images: { poster: `${poster}.jpg` } }], options);
  assert.equal(imagePointerSeverity(changedPointer), 'error');
  const [newHero] = findImagePointerProblems([{ id, images: { hero: poster } }], options);
  assert.equal(imagePointerSeverity(newHero), 'error');
  assert.equal(imagePointerSeverity({ ...known, reason: 'invalid or unreadable image pointer' }), 'error');
});

test('the repaired Ford Hill hero exists and no longer has a baseline exception', () => {
  const id = 'the-ford-hill-project-off-broadway-2026';
  const hero = `/images/shows/${id}/hero.webp`;
  assert.deepEqual(findImagePointerProblems([{ id, images: { hero } }], {
    publicDir: path.resolve(import.meta.dirname, '../../public'),
  }), []);
  assert.equal(imagePointerSeverity({ id, key: 'hero', value: hero,
    reason: 'local image file does not exist' }), 'error');
});

test('a repaired baseline pointer stops producing warnings', () => {
  const id = 'the-ford-hill-project-off-broadway-2026';
  assert.deepEqual(findImagePointerProblems([{ id, images: { hero: poster } }], options), []);
});
