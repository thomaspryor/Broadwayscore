// BRO-4906: an unverified Google candidate never touches the live image file.
// Requires the REAL staging helpers (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  stagedPathFor, writeStagedCandidate, discardStaged, stagedBytesFor, stageImageSnapshot, finalizeStaged, sweepStagedCandidates,
} = require('./image-candidate-staging.js');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function showDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4906-'));
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), Buffer.from('LIVE-THUMBNAIL-BYTES'));
  fs.writeFileSync(path.join(dir, 'poster.jpg'), Buffer.from('LIVE-POSTER-BYTES'));
  return dir;
}
const LOCAL_T = '/images/shows/x/thumbnail.jpg';
const LOCAL_P = '/images/shows/x/poster.jpg';

test('stagedPathFor keeps the extension and marks the name', () => {
  assert.equal(stagedPathFor('/a/b/thumbnail.jpg'), '/a/b/thumbnail.candidate.jpg');
});

test('a rejected Google candidate leaves the live thumbnail byte-identical', () => {
  const dir = showDir();
  const live = path.join(dir, 'thumbnail.jpg');
  const before = sha(live);
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: LOCAL_T, final: live }, Buffer.from('UNVERIFIED-GOOGLE'));
  assert.equal(sha(live), before, 'staging must not write the live file');
  // Rejected: the row serves no Google thumbnail.
  const r = finalizeStaged(staged, { thumbnail: null });
  assert.deepEqual(r, { promoted: [], discarded: ['thumbnail'] });
  assert.equal(sha(live), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['poster.jpg', 'thumbnail.jpg']);
});

test('the keep-existing-thumbnail branch (row still serves the same path) keeps the live bytes when the stage was discarded', () => {
  const dir = showDir();
  const live = path.join(dir, 'thumbnail.jpg');
  const before = sha(live);
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: LOCAL_T, final: live }, Buffer.from('POSTER-CROP'));
  assert.equal(discardStaged(staged, 'thumbnail'), true);
  finalizeStaged(staged, { thumbnail: LOCAL_T });
  assert.equal(sha(live), before);
});

test('an accepted candidate the row serves is renamed into place; an unserved one is deleted', () => {
  const dir = showDir();
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: LOCAL_T, final: path.join(dir, 'thumbnail.jpg') }, Buffer.from('NEW-THUMB'));
  writeStagedCandidate(staged, 'poster', { local: LOCAL_P, final: path.join(dir, 'poster.jpg') }, Buffer.from('NEW-POSTER'));
  const r = finalizeStaged(staged, { thumbnail: LOCAL_T, poster: null });
  assert.deepEqual(r, { promoted: ['thumbnail'], discarded: ['poster'] });
  assert.equal(fs.readFileSync(path.join(dir, 'thumbnail.jpg'), 'utf8'), 'NEW-THUMB');
  assert.equal(fs.readFileSync(path.join(dir, 'poster.jpg'), 'utf8'), 'LIVE-POSTER-BYTES');
  assert.deepEqual(staged, {});
});

test('stagedBytesFor returns the candidate bytes, not the live file', () => {
  const dir = showDir();
  const live = path.join(dir, 'thumbnail.jpg');
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: LOCAL_T, final: live }, Buffer.from('CANDIDATE'));
  assert.equal(stagedBytesFor(staged, live).toString(), 'CANDIDATE');
  assert.equal(stagedBytesFor(staged, path.join(dir, 'poster.jpg')), null);
});

test('sweepStagedCandidates removes only *.candidate.* leftovers', () => {
  const dir = showDir();
  fs.writeFileSync(path.join(dir, 'thumbnail.candidate.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'poster.candidate.jpg'), 'y');
  assert.deepEqual(sweepStagedCandidates(dir).sort(), ['poster.candidate.jpg', 'thumbnail.candidate.jpg']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['poster.jpg', 'thumbnail.jpg']);
  assert.deepEqual(sweepStagedCandidates(path.join(dir, 'missing')), []);
});

test('a staged candidate path under public/images/shows is gitignored, so a crashed run cannot commit it', async () => {
  const { execFileSync } = await import('node:child_process');
  const staged = stagedPathFor(path.join('public', 'images', 'shows', 'some-show', 'thumbnail.webp'));
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  // check-ignore exits 0 when the path is ignored (the file need not exist).
  execFileSync('git', ['check-ignore', '-q', '--no-index', staged], { cwd: repo });
});

test('finalizeStaged reports a served format whose rename failed as discarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-rename-'));
  const final = path.join(dir, 'thumbnail.webp');
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: '/images/shows/x/thumbnail.webp', final }, Buffer.from('new'));
  const failingFs = { ...fs, existsSync: fs.existsSync, renameSync: () => { throw new Error('EXDEV'); }, unlinkSync: fs.unlinkSync };
  const r = finalizeStaged(staged, { thumbnail: '/images/shows/x/thumbnail.webp' }, failingFs);
  assert.deepEqual(r, { promoted: [], discarded: ['thumbnail'] });
  assert.equal(fs.existsSync(final), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('a deferred photo snapshot survives later rejected retries and is written only when served', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const final = path.join(root, 'x', 'thumbnail.jpg');
  const staged = {};
  const photo = Buffer.from('VERIFIED-PRODUCTION-PHOTO');
  writeStagedCandidate(staged, 'thumbnail', { local: LOCAL_T, final }, photo);
  const files = { [final]: stagedBytesFor(staged, final) };
  const retry = {};
  writeStagedCandidate(retry, 'thumbnail', { local: LOCAL_T, final }, Buffer.from('REJECTED-RETRY'));
  discardStaged(retry, 'thumbnail');
  const fallback = stageImageSnapshot({ thumbnail: LOCAL_T, poster: 'https://cdn.example/poster.jpg' }, files, root);
  assert.equal(fs.existsSync(path.dirname(final)), false);
  assert.deepEqual(Object.keys(fallback), ['thumbnail']);
  finalizeStaged(fallback, { thumbnail: LOCAL_T });
  assert.deepEqual(fs.readFileSync(final), photo);
});

test('a chosen photo subsequently refused by ownership checks never reaches disk', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-refused-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const final = path.join(root, 'x', 'thumbnail.jpg');
  const fallback = stageImageSnapshot({ thumbnail: LOCAL_T }, { [final]: Buffer.from('PHOTO') }, root);
  assert.equal(discardStaged(fallback, 'thumbnail'), true);
  finalizeStaged(fallback, { thumbnail: null });
  assert.equal(fs.existsSync(path.dirname(final)), false);
});

test('a final write failure preserves existing art and removes the partial accepted candidate', t => {
  const dir = showDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const final = path.join(dir, 'thumbnail.jpg');
  const before = sha(final);
  const staged = {};
  writeStagedCandidate(staged, 'thumbnail', { local: LOCAL_T, final }, Buffer.from('ACCEPTED'));
  const failingFs = { ...fs, writeFileSync: (file, bytes) => {
    fs.writeFileSync(file, bytes.subarray(0, 2));
    throw new Error('ENOSPC');
  } };
  assert.deepEqual(finalizeStaged(staged, { thumbnail: LOCAL_T }, failingFs), { promoted: [], discarded: ['thumbnail'] });
  assert.equal(sha(final), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['poster.jpg', 'thumbnail.jpg']);
});
