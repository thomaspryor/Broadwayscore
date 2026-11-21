import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findImagePointerProblems, imagePointerSeverity } = require('./image-pointers');
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-pointers-'));
after(() => fs.rmSync(publicDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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

// BRO-6221: 272 thumbnail/poster refs on closed shows pointed at files never in public/.
const { findDanglingLocalImageRefs, danglingImageNullingActions } = require('./image-pointers');

test('dangling refs: missing local thumbnail/poster/hero are listed; present files, query strings, null and remote pass', () => {
  const shows = [
    { id: 'show', images: { thumbnail: `${poster}?v=abc`, poster, hero: null } },
    { id: 'gone', images: { thumbnail: '/images/shows/gone/thumbnail.jpg', poster: '/images/shows/gone/poster.jpg', hero: 'https://images.ctfassets.net/our-space/h.jpg' } },
    { id: 'dir', images: { thumbnail: '/images/shows/show' } },
    { id: 'bad', images: { poster: '/images/%zz.jpg' } },
    { id: 'none' },
  ];
  assert.deepEqual(findDanglingLocalImageRefs(shows, { publicDir }), [
    { id: 'gone', key: 'thumbnail', value: '/images/shows/gone/thumbnail.jpg' },
    { id: 'gone', key: 'poster', value: '/images/shows/gone/poster.jpg' },
    { id: 'dir', key: 'thumbnail', value: '/images/shows/show' },
    { id: 'bad', key: 'poster', value: '/images/%zz.jpg' },
  ]);
});

test('nulling actions: one compare-and-set images edit per show, only dangling keys nulled, input unchanged', () => {
  const shows = [
    { id: 'gone', images: { thumbnail: '/images/shows/gone/thumbnail.jpg', poster: '/images/shows/gone/poster.jpg', hero: '/images/shows/show/poster.jpg' } },
    { id: 'show', images: { poster } },
  ];
  const before = JSON.stringify(shows);
  const actions = danglingImageNullingActions(shows, findDanglingLocalImageRefs(shows, { publicDir }));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].showId, 'gone');
  assert.equal(actions[0].field, 'images');
  assert.deepEqual(actions[0].oldValue, shows[0].images);
  assert.deepEqual(actions[0].newValue, { thumbnail: null, poster: null, hero: '/images/shows/show/poster.jpg' });
  assert.equal(JSON.stringify(shows), before);
});

test('the plan executor accepts the generated nulling edit (data-edit-action images rules)', () => {
  const { applyDataEdit } = require('./data-edit-action');
  const shows = [{ id: 'gone', images: { thumbnail: '/images/shows/gone/thumbnail.jpg', poster: null, hero: null } }];
  const [action] = danglingImageNullingActions(shows, findDanglingLocalImageRefs(shows, { publicDir }));
  const data = { shows: JSON.parse(JSON.stringify(shows)) };
  const res = applyDataEdit(data, action, { root: path.dirname(publicDir) });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(data.shows[0].images, { thumbnail: null, poster: null, hero: null });
});

// BRO-7097: in a slim (sparse-checkout) Codex worktree a missing image proves nothing.
test('slim sparse trees: image finders report nothing instead of flagging every local image', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs'); const os = await import('node:os'); const pth = await import('node:path');
  const dir = fs.mkdtempSync(pth.join(os.tmpdir(), 'sparse-img-'));
  try {
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
    fs.mkdirSync(pth.join(dir, 'public/images/shows'), { recursive: true });
    fs.writeFileSync(pth.join(dir, 'public/images/shows/a.webp'), 'x');
    g('add', '-A'); g('commit', '-qm', 'x');
    const publicDir = pth.join(dir, 'public');
    const shows = [{ id: 'a', images: { hero: '/images/shows/a.webp', thumbnail: '/images/shows/a.webp' } }];
    const mod = (await import('./image-pointers.js')).default;
    assert.equal(mod.isSparseTree(publicDir), false);
    g('sparse-checkout', 'set', '--no-cone', '/*', '!/public/images/shows/');
    assert.equal(fs.existsSync(pth.join(publicDir, 'images/shows/a.webp')), false);
    assert.equal(mod.isSparseTree(publicDir), true);
    assert.deepEqual(mod.findImagePointerProblems(shows, { publicDir }), []);
    assert.deepEqual(mod.findDanglingLocalImageRefs(shows, { publicDir }), []);
    // A missing file OUTSIDE the excluded dirs is still a real problem in a slim tree.
    const other = [{ id: 'b', images: { hero: '/images/theaters/nope.webp' } }];
    assert.equal(mod.findImagePointerProblems(other, { publicDir }).length, 1);
    g('sparse-checkout', 'disable');
    assert.equal(mod.isSparseTree(publicDir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
