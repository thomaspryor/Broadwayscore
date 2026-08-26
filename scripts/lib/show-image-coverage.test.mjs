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
 *
 * BRO-179: this module's functions were folded into show-images.js (single
 * home for both the declared-path and archived-file coverage predicates).
 * hasArchivedShowImages was renamed archivedFilesExist there — this file keeps
 * its own name/scope (archived-file coverage) rather than merging into
 * show-images.test.mjs, which covers the consolidated module as a whole.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  archivedFilesExist: hasArchivedShowImages,
  listShowIdsWithImages,
  pruneEmptyShowImageDir,
  snapshotShowImageDir,
  discardFailedFetchArtifacts,
  dirHasImageFiles,
} = require('./show-images.js');

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

test('listShowIdsWithImages THROWS on an unreadable root — never a confident empty set', () => {
  // Returning an empty Set here would make process-feedback.js declare EVERY
  // show in the catalogue imageless. Its caller keeps showIdsMissingImages null
  // ("unknown") only because this throws.
  assert.throws(() => listShowIdsWithImages(path.join(makeRoot(), 'does-not-exist')));
});

test('one unreadable show dir does not poison the whole listing', () => {
  const root = makeRoot();
  seed(root, 'has-art', ['poster.webp']);
  seed(root, 'empty', []);
  const covered = listShowIdsWithImages(root);
  assert.equal(covered.has('has-art'), true);
  assert.equal(covered.has('empty'), false);
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

test('pruneEmptyShowImageDir leaves a NESTED image folder alone', () => {
  // Codex P0: a recursive delete would have destroyed originals/ archives.
  // rmdir refuses a non-empty directory, so nesting is safe by construction.
  const root = makeRoot();
  const dir = path.join(root, 'nested');
  fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'originals', 'poster.webp'), 'x');
  assert.equal(pruneEmptyShowImageDir(dir), false);
  assert.equal(fs.existsSync(path.join(dir, 'originals', 'poster.webp')), true);
});

test('pruneEmptyShowImageDir leaves an in-flight partial download alone', () => {
  // A concurrent writer mid-download has a .tmp/partial file in the dir. Even
  // though that is not coverage, deleting it would corrupt another run.
  const root = makeRoot();
  const dir = seed(root, 'downloading', ['poster.webp.tmp']);
  assert.equal(pruneEmptyShowImageDir(dir), false);
  assert.equal(fs.existsSync(path.join(dir, 'poster.webp.tmp')), true);
});

test('a junk-only dir is NOT coverage but is also NOT deleted', () => {
  // Two separate properties. Coverage must be false (that is the bug fix);
  // deletion must be false (we do not destroy files we did not write).
  const root = makeRoot();
  const dir = seed(root, 'junk', ['.DS_Store', 'attempt.json']);
  assert.equal(hasArchivedShowImages(root, 'junk'), false);
  assert.equal(pruneEmptyShowImageDir(dir), false);
  assert.equal(fs.existsSync(dir), true);
});

test('pruneEmptyShowImageDir on a nonexistent path is a no-op, not a throw', () => {
  assert.equal(pruneEmptyShowImageDir(path.join(makeRoot(), 'nope')), false);
});

test('a DIRECTORY named poster.webp is not key art', () => {
  // Guards the isFile() check: a non-regular entry with an image extension must
  // not fake coverage (and must not shield a junk dir from cleanup).
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'weird', 'poster.webp'), { recursive: true });
  assert.equal(hasArchivedShowImages(root, 'weird'), false);
  assert.equal(listShowIdsWithImages(root).has('weird'), false);
});

test('dirHasImageFiles is case-insensitive on the extension', () => {
  const root = makeRoot();
  const dir = seed(root, 'shouty', ['POSTER.WEBP']);
  assert.equal(dirHasImageFiles(dir), true);
});

// ---------------------------------------------------------------------------
// Second adversarial review (Codex, 2026-08-02) found the empty-dir prune was
// blind to the WORSE shape of the same bug: several fetch paths write
// thumbnail.jpg to disk BEFORE Gemini verifies it, so a rejected candidate
// leaves a real file. That file satisfies every file-based coverage check while
// shows.json still records no image — so the page renders "Images coming soon"
// on a show the system believes is covered.
// ---------------------------------------------------------------------------

test('a rejected candidate written pre-verification is discarded, dir pruned', () => {
  const root = makeRoot();
  const dir = path.join(root, 'rejected-show');
  fs.mkdirSync(dir, { recursive: true });
  const before = snapshotShowImageDir(dir);          // taken pre-fetch: empty
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'x'); // written, then rejected

  assert.equal(hasArchivedShowImages(root, 'rejected-show'), true, 'precondition: it DOES read as coverage');
  const { removed, prunedDir } = discardFailedFetchArtifacts(dir, before);
  assert.deepEqual(removed, ['thumbnail.jpg']);
  assert.equal(prunedDir, true);
  assert.equal(hasArchivedShowImages(root, 'rejected-show'), false);
});

test('pre-existing archived art SURVIVES a failed refetch', () => {
  // The failure path must never be able to destroy a previously good poster.
  const root = makeRoot();
  const dir = seed(root, 'has-good-art', ['poster.webp', 'thumbnail.webp']);
  const before = snapshotShowImageDir(dir);
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'x'); // this run's reject

  const { removed, prunedDir } = discardFailedFetchArtifacts(dir, before);
  assert.deepEqual(removed, ['thumbnail.jpg'], 'only this run’s file removed');
  assert.equal(prunedDir, false, 'dir kept — it still holds real art');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['poster.webp', 'thumbnail.webp']);
  assert.equal(hasArchivedShowImages(root, 'has-good-art'), true);
});

test('discard never recurses into a nested archive directory', () => {
  const root = makeRoot();
  const dir = path.join(root, 'nested');
  fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'originals', 'poster.webp'), 'x');
  const before = snapshotShowImageDir(dir); // contains 'originals'
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'x');

  const { removed } = discardFailedFetchArtifacts(dir, before);
  assert.deepEqual(removed, ['thumbnail.jpg']);
  assert.equal(fs.existsSync(path.join(dir, 'originals', 'poster.webp')), true);
});

test('a NEW nested dir is not deleted either (only files are)', () => {
  const root = makeRoot();
  const dir = path.join(root, 'newnested');
  fs.mkdirSync(dir, { recursive: true });
  const before = snapshotShowImageDir(dir);
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  const { removed, prunedDir } = discardFailedFetchArtifacts(dir, before);
  assert.deepEqual(removed, []);
  assert.equal(prunedDir, false, 'rmdir refuses: something is inside');
  assert.equal(fs.existsSync(path.join(dir, 'tmp')), true);
});

test('discard on a missing dir is a no-op, not a throw', () => {
  const r = discardFailedFetchArtifacts(path.join(makeRoot(), 'nope'), new Set());
  assert.deepEqual(r, { removed: [], prunedDir: false });
});
