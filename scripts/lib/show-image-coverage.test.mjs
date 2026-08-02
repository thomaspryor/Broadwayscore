/**
 * show-image-coverage.test.mjs
 *
 * Locks down the empty-directory coverage blind spot (2026-08-02).
 *
 * fetch-show-images-auto.js mkdir's public/images/shows/<id>/ before it knows
 * whether any candidate will pass verification. A show whose candidates are all
 * rejected therefore leaves an EMPTY directory behind. Readers that decided
 * coverage from directory existence — process-feedback.js's content router did —
 * then counted that show as having art and dropped it from the imageless cohort.
 * That is how an imageless show reaches the live homepage showing "Images coming
 * soon" (Brainiac Live at the Garrick; The Gin Game before it).
 *
 * These assert on the REAL exported functions, against real directories on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasArchivedShowImages,
  listShowIdsWithImages,
  pruneEmptyShowImageDir,
  dirHasImageFiles,
} = require('./show-image-coverage.js');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'img-coverage-'));
}
function seed(root, showId, files) {
  const dir = path.join(root, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

test('an EMPTY show dir is NOT coverage (the whole bug)', () => {
  const root = makeRoot();
  seed(root, 'brainiac-live-west-end-2026', []); // failed fetch left the dir
  assert.equal(hasArchivedShowImages(root, 'brainiac-live-west-end-2026'), false);
  // existsSync would have said true — that is precisely the regression.
  assert.equal(fs.existsSync(path.join(root, 'brainiac-live-west-end-2026')), true);
});

test('a dir holding real art IS coverage', () => {
  const root = makeRoot();
  seed(root, 'hamilton', ['poster.webp', 'thumbnail.webp', 'hero.webp']);
  assert.equal(hasArchivedShowImages(root, 'hamilton'), true);
});

test('a missing dir is not coverage, and does not throw', () => {
  const root = makeRoot();
  assert.equal(hasArchivedShowImages(root, 'never-fetched'), false);
  assert.equal(hasArchivedShowImages(root, ''), false);
  assert.equal(hasArchivedShowImages(root, undefined), false);
});

test('non-image junk does not count as coverage', () => {
  const root = makeRoot();
  // A sidecar or a macOS turd must not make an imageless show read as covered.
  seed(root, 'the-holes-off-broadway-2026', ['.DS_Store', 'attempt.json']);
  assert.equal(hasArchivedShowImages(root, 'the-holes-off-broadway-2026'), false);
});

test('legacy non-webp archives still count', () => {
  const root = makeRoot();
  seed(root, 'old-show', ['thumbnail.jpg']);
  assert.equal(hasArchivedShowImages(root, 'old-show'), true);
});

test('listShowIdsWithImages excludes empty dirs — the process-feedback.js fix', () => {
  const root = makeRoot();
  seed(root, 'has-art', ['poster.webp']);
  seed(root, 'empty-after-failed-fetch', []);
  seed(root, 'junk-only', ['.DS_Store']);
  const covered = listShowIdsWithImages(root);
  assert.deepEqual([...covered].sort(), ['has-art']);
  // The pre-fix implementation was `new Set(fs.readdirSync(root))`, which would
  // have returned all three. Assert that specific wrong answer is not produced.
  assert.equal(covered.has('empty-after-failed-fetch'), false);
  assert.equal(covered.has('junk-only'), false);
});

test('listShowIdsWithImages on a missing root returns empty, not a throw', () => {
  assert.equal(listShowIdsWithImages(path.join(makeRoot(), 'nope')).size, 0);
});

test('pruneEmptyShowImageDir removes an empty dir', () => {
  const root = makeRoot();
  const dir = seed(root, 'failed', []);
  assert.equal(pruneEmptyShowImageDir(dir), true);
  assert.equal(fs.existsSync(dir), false);
});

test('pruneEmptyShowImageDir NEVER deletes real key art', () => {
  const root = makeRoot();
  const dir = seed(root, 'brainiac-live-west-end-2026', ['poster.webp', 'thumbnail.webp', 'hero.webp']);
  assert.equal(pruneEmptyShowImageDir(dir), false);
  assert.equal(fs.existsSync(dir), true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['hero.webp', 'poster.webp', 'thumbnail.webp']);
});

test('pruneEmptyShowImageDir clears a junk-only dir (it is not coverage either)', () => {
  const root = makeRoot();
  const dir = seed(root, 'junk', ['.DS_Store']);
  assert.equal(pruneEmptyShowImageDir(dir), true);
  assert.equal(fs.existsSync(dir), false);
});

test('pruneEmptyShowImageDir on a nonexistent path is a no-op, not a throw', () => {
  assert.equal(pruneEmptyShowImageDir(path.join(makeRoot(), 'nope')), false);
});

test('dirHasImageFiles is case-insensitive on the extension', () => {
  const root = makeRoot();
  const dir = seed(root, 'shouty', ['POSTER.WEBP']);
  assert.equal(dirHasImageFiles(dir), true);
});
