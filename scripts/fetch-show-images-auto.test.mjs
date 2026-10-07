/**
 * fetch-show-images-auto.test.mjs
 *
 * BRO-178: processOneShow must run failed-fetch cleanup on the THROW path, not
 * just after fetchShowImages resolves. A throw between a source's mkdir and its
 * write (sharp failure, OOM, disk error) used to propagate straight out,
 * leaving Promise.allSettled recording a rejection and the freshly created
 * directory/partial file surviving as false coverage.
 *
 * processOneShow itself isn't exported (fetch-show-images-auto.js runs main()
 * unconditionally at module load, so it can't be require()'d in a test). The
 * fix lives in scripts/lib/show-image-coverage.js's runFetchWithCleanup, which
 * processOneShow calls directly — these tests assert on that REAL exported
 * function, against real directories on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runFetchWithCleanup,
  snapshotShowImageDir,
} = require('./lib/show-image-coverage.js');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-cleanup-'));
}
function seed(root, showId, files) {
  const dir = path.join(root, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}
function silent() {} // suppress log noise in test output

test('throw between mkdir and write: dir removed AND the original error propagates unchanged', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'throws-empty');
  const before = snapshotShowImageDir(dir); // taken pre-fetch: dir does not exist yet

  const boom = new Error('sharp: unsupported image format');
  const fetchFn = async () => {
    fs.mkdirSync(dir, { recursive: true }); // source mkdir's before it knows if any candidate verifies
    throw boom; // ...then blows up before any write
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'throws-empty', silent),
    (err) => err === boom // exact same error object — not wrapped, not swallowed
  );
  assert.equal(fs.existsSync(dir), false, 'empty dir left by the throw must be pruned');
});

test('throw after a candidate file was written: file removed too, error still propagates', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'throws-with-file');
  fs.mkdirSync(dir, { recursive: true });
  const before = snapshotShowImageDir(dir); // empty at snapshot time

  const boom = new Error('ENOSPC: no space left on device');
  const fetchFn = async () => {
    fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'partial'); // written before verification
    throw boom; // then the run fails before shows.json records anything
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'throws-with-file', silent),
    (err) => err === boom
  );
  // the rejected candidate is removed, which empties the dir, which is then pruned too
  assert.equal(fs.existsSync(dir), false, 'the rejected candidate file must not survive as false coverage');
});

test('successful fetch: files and return value untouched (regression guard)', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'succeeds');
  const before = snapshotShowImageDir(dir);

  const fetchFn = async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'poster.webp'), 'real-art');
    return { thumbnail: 'poster.webp' }; // truthy result = success
  };

  const result = await runFetchWithCleanup(fetchFn, dir, before, 'succeeds', silent);
  assert.deepEqual(result, { thumbnail: 'poster.webp' });
  assert.deepEqual(fs.readdirSync(dir), ['poster.webp'], 'cleanup must not touch a successful fetch');
});

test('throwing refetch on a show with existing archived art: archived art survives', async () => {
  const root = makeRoot();
  const dir = seed(root, 'has-good-art', ['poster.webp', 'thumbnail.webp']);
  const before = snapshotShowImageDir(dir); // snapshot captures the pre-existing files

  const boom = new Error('network timeout');
  const fetchFn = async () => {
    fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'rejected-candidate'); // this run's reject
    throw boom;
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'has-good-art', silent),
    (err) => err === boom
  );
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['poster.webp', 'thumbnail.webp'],
    'only this run’s rejected file is removed — previously archived art must never be destroyed'
  );
});

test('cleanup runs and rethrows unchanged even when nothing needs discarding', async () => {
  // No mkdir at all before the throw (the source failed before it wrote
  // anything) — discardFailedFetchArtifacts sees a missing directory and is a
  // no-op, but the finally block must still run and the original error must
  // still be the one that surfaces.
  const root = makeRoot();
  const dir = path.join(root, 'never-created');
  const before = snapshotShowImageDir(dir);

  const boom = new Error('discoverTodayTixId timed out');
  const fetchFn = async () => {
    throw boom;
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'never-created', silent),
    (err) => err === boom
  );
  assert.equal(fs.existsSync(dir), false);
});
