import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { versionedImagePath } = require('./versioned-image-path.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-'));
  fs.mkdirSync(path.join(dir, 'images', 'shows', 'x'), { recursive: true });
  return dir;
}

test('URL changes when the file bytes change, and only then (BRO-5734)', () => {
  const dir = fixture();
  const f = path.join(dir, 'images', 'shows', 'x', 'poster.jpg');
  fs.writeFileSync(f, 'prime video poster');
  const a = versionedImagePath('/images/shows/x/poster.jpg', dir);
  assert.match(a, /^\/images\/shows\/x\/poster\.jpg\?v=[0-9a-f]{8}$/);
  assert.equal(versionedImagePath('/images/shows/x/poster.jpg', dir), a);
  fs.writeFileSync(f, 'the real SoHo Playhouse poster');
  assert.notEqual(versionedImagePath('/images/shows/x/poster.jpg', dir), a);
});

test('non-local, already-versioned, missing and traversal paths pass through', () => {
  const dir = fixture();
  for (const p of ['https://cdn.example.com/a.jpg', '/images/shows/x/poster.jpg?v=1', '/images/shows/x/missing.jpg', '/images/../secret.jpg', '/other/a.jpg', null, undefined, '']) {
    assert.equal(versionedImagePath(p, dir), p);
  }
});

test('a directory is not versioned', () => {
  const dir = fixture();
  assert.equal(versionedImagePath('/images/shows/x', dir), '/images/shows/x');
});

test('every mobile feed generator versions the paths it emits (BRO-5734)', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const [file, needle] of [
    ['generate-mobile-data.js', /img\.th = versionedImagePath\(/],
    ['generate-mobile-data.js', /img\.po = versionedImagePath\(/],
    // BRO-6170: pickWinnerImage versions whichever existing file it picks.
    ['generate-stats-canon.js', /return versionedImagePath\(p, publicDir\)/],
  ]) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), needle, `${file} no longer versions its image paths`);
  }
});

test('cloud stub strips the ?v= suffix back to plain file paths (BRO-5734)', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.match(fs.readFileSync(path.join(root, 'cloud-stub-data.js'), 'utf8'), /s\.img\.th\.split\('\?'\)\[0\]/);
});

// BRO-5736: every generator that emits an /images/ path to a feed must version it,
// and the mobile detail hash must cover the hero bytes (else a replaced hero keeps a stale ?v=).
test('feed generators version their image paths', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(read('generate-search-shows.js'), /thumbnail: versionedImagePath\(show\.images\.thumbnail\)/);
  assert.match(read('generate-show-lookup.js'), /entry\.p = versionedImagePath\(show\.images\.poster\)/);
  assert.match(read('generate-show-lookup.js'), /entry\.p = versionedImagePath\(show\.images\.thumbnail\)/);
  const details = read('generate-mobile-show-details.js');
  assert.match(details, /detail\.hi = versionedImagePath\(heroPath\)/);
  assert.match(details, /hash\.update\(`hero=\$\{path\.basename\(hf\)\}`\)/);
});
