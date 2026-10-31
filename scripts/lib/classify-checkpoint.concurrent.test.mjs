// Spawns real concurrent processes to prove the classify-checkpoint write
// lock + read-merge-write actually keeps both runs' progress. Without it,
// whichever process writes last erases the other's key — the #893 class
// bug (task #925). See scripts/lib/gap-audit-merge.concurrent.test.mjs for
// the sibling test this one is modeled on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.join(__dirname, 'classify-checkpoint.js');
const require = createRequire(import.meta.url);
const { mergeWriteCheckpoint, deleteCheckpointIfCaughtUp } = require('./classify-checkpoint.js');

// Worker source run in a fresh `node -e` process. Each worker's in-memory
// "localCheckpoint" is seeded with ONLY its own key — exactly like a real
// classify-wrong-show.js/classify-wrong-production.js run, which never learns
// about a sibling run's newly-classified keys except through
// mergeWriteCheckpoint's own read-under-lock. Both workers wait on a shared
// barrier file so their mergeWriteCheckpoint calls land at nearly the same
// instant, forcing real lock contention (not just sequential calls).
function workerSource(checkpointPath, barrierPath, ownKey) {
  return `
    const { mergeWriteCheckpoint } = require(${JSON.stringify(LIB_PATH)});
    const fs = require('fs');
    const barrierPath = ${JSON.stringify(barrierPath)};
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(barrierPath) && Date.now() < deadline) { /* spin for the barrier */ }
    const localCheckpoint = { [${JSON.stringify(ownKey)}]: { classifiedBy: ${JSON.stringify(ownKey)} } };
    mergeWriteCheckpoint(${JSON.stringify(checkpointPath)}, localCheckpoint);
  `;
}

function runWorker(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`));
      else resolve();
    });
  });
}

test('two concurrent writers each keep their own checkpoint key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ckpt-'));
  const checkpointPath = path.join(dir, '.checkpoint.json');
  const barrierPath = path.join(dir, '.barrier');

  const workerA = runWorker(workerSource(checkpointPath, barrierPath, 'showA/reviewA.json'));
  const workerB = runWorker(workerSource(checkpointPath, barrierPath, 'showB/reviewB.json'));

  // Give both workers a moment to reach their barrier-poll loop, then release
  // them at (as close as a filesystem write gets to) the same instant.
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(barrierPath, 'go');

  await Promise.all([workerA, workerB]);

  const final = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  assert.equal(Object.keys(final).length, 2, `expected both keys to survive, got: ${JSON.stringify(final)}`);
  assert.ok(final['showA/reviewA.json'], 'showA key missing — a concurrent writer clobbered it');
  assert.ok(final['showB/reviewB.json'], 'showB key missing — a concurrent writer clobbered it');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleteCheckpointIfCaughtUp refuses to delete when disk has an unknown key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ckpt-'));
  const checkpointPath = path.join(dir, '.checkpoint.json');

  // Simulate a concurrent run merging in a key this run never saw.
  mergeWriteCheckpoint(checkpointPath, { 'showX/other.json': { classifiedBy: 'other-run' } });

  const knownToThisRun = { 'showY/mine.json': { classifiedBy: 'this-run' } };
  const deleted = deleteCheckpointIfCaughtUp(checkpointPath, knownToThisRun);

  assert.equal(deleted, false, 'must not delete when the disk holds a key this run does not know about');
  assert.ok(fs.existsSync(checkpointPath), 'checkpoint file should still exist');

  fs.rmSync(dir, { recursive: true, force: true });
});
