import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const images = require('./show-images.js');
const coverage = require('./show-image-coverage.js');
const { writeStagedCandidate, stagedBytesFor, finalizeStaged } = require('./image-candidate-staging.js');

function fixture(t) {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro179-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  const root = path.join(publicDir, 'images', 'shows');
  const dir = path.join(root, 'show');
  fs.mkdirSync(dir, { recursive: true });
  return { publicDir, root, dir };
}

test('legacy entry point forwards to the canonical module, including throw cleanup', () => {
  assert.equal(coverage, images);
  assert.equal(typeof images.runFetchWithCleanup, 'function');
});

test('declared and archived checks share the placeholder rule', t => {
  const { publicDir, root, dir } = fixture(t);
  const bytes = Buffer.from('known placeholder fixture');
  const hash = crypto.createHash('md5').update(bytes).digest('hex');
  images.PLACEHOLDER_FILE_HASHES.add(hash);
  t.after(() => images.PLACEHOLDER_FILE_HASHES.delete(hash));
  fs.writeFileSync(path.join(dir, 'poster.webp'), bytes);
  assert.equal(images.imageOnDisk('/images/shows/show/poster.webp', { publicDir }), false);
  assert.equal(coverage.hasArchivedShowImages(root, 'show'), false);
  assert.deepEqual([...images.listShowIdsWithImages(root)], []);
});

test('directories, non-image files and candidate files do not count in either check', t => {
  const { publicDir, root, dir } = fixture(t);
  fs.mkdirSync(path.join(dir, 'poster.webp'));
  fs.writeFileSync(path.join(dir, 'attempt.json'), '{}');
  fs.writeFileSync(path.join(dir, 'thumbnail.candidate.jpg'), 'unverified');
  for (const name of ['poster.webp', 'attempt.json', 'thumbnail.candidate.jpg']) {
    assert.equal(images.imageOnDisk(`/images/shows/show/${name}`, { publicDir }), false, name);
  }
  assert.equal(coverage.hasArchivedShowImages(root, 'show'), false);
});

test('a real file covers the archive but cannot satisfy a different declared path', t => {
  const { publicDir, root, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'art');
  assert.equal(images.imageOnDisk('/images/shows/show/poster.webp', { publicDir }), false);
  assert.equal(images.imageOnDisk('/images/shows/show/thumbnail.jpg', { publicDir }), true);
  assert.equal(coverage.hasArchivedShowImages(root, 'show'), true);
});

test('candidate bytes stay in memory until accepted and chosen', t => {
  const { dir } = fixture(t);
  const final = path.join(dir, 'new', 'thumbnail.jpg');
  const local = '/images/shows/show/thumbnail.jpg';
  const staged = {};
  const bytes = Buffer.from('candidate bytes');
  writeStagedCandidate(staged, 'thumbnail', { local, final }, bytes);
  assert.equal(fs.existsSync(path.dirname(final)), false, 'no directory or candidate file before verification');
  assert.deepEqual(stagedBytesFor(staged, final), bytes);
  assert.deepEqual(finalizeStaged(staged, { thumbnail: local }), { promoted: ['thumbnail'], discarded: [] });
  assert.deepEqual(fs.readFileSync(final), bytes);
});

test('rejection writes nothing to disk', t => {
  const { dir } = fixture(t);
  const final = path.join(dir, 'new', 'thumbnail.jpg');
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: '/images/shows/show/thumbnail.jpg', final }, Buffer.from('rejected'));
  assert.deepEqual(finalizeStaged(staged, { thumbnail: null }), { promoted: [], discarded: ['thumbnail'] });
  assert.equal(fs.existsSync(path.dirname(final)), false);
});
