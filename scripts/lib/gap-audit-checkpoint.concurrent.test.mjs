// Task #923 — the #893 race class, one file over. Mirrors
// gap-audit-merge.concurrent.test.mjs, which proves the same property for
// show-review-gap.json: N real, concurrent child processes each stamp a
// DIFFERENT show id into gap-audit-checkpoint.json and every one must survive
// — no lost update, even though every writer read-modify-writes the same
// file at (almost) the same instant.
//
// Run: node --test scripts/lib/gap-audit-checkpoint.concurrent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const LIB = path.resolve(new URL('./gap-audit-checkpoint.js', import.meta.url).pathname);
const { saveCheckpointEntries } = require('./gap-audit-checkpoint.js');

const WORKERS = 8;

// Merge-aware worker: exactly what saveCheckpointEntries does — the real
// call sites in audit-show-review-gap.js just call this directly.
const WORKER_SRC = `
const { saveCheckpointEntries } = require(process.argv[2]);
const target = process.argv[3];
const showId = process.argv[4];
saveCheckpointEntries(target, { [showId]: { at: new Date().toISOString(), gaps: 0, workerId: showId } });
`;

// Whole-object worker: the PRE-#923 shape (saveCheckpoint(wholeInMemoryCopy),
// unlocked). Used only to prove the concurrent test below is non-vacuous —
// it must FAIL against this implementation, exactly like #902 proved for the
// show-review-gap.json lock.
const WHOLE_OBJECT_WORKER_SRC = `
const fs = require('fs');
const target = process.argv[2];
const showId = process.argv[3];
let checkpoint = {};
try { checkpoint = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { checkpoint = {}; }
checkpoint[showId] = { at: new Date().toISOString(), gaps: 0, workerId: showId };
// Widen the interleaving window — real runs do real work (SERP calls, disk
// I/O) between the read and the write; a bare synchronous write would race
// so tightly the bug barely reproduces in a unit test.
const until = Date.now() + 40;
while (Date.now() < until) { /* spin */ }
const tmp = target + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
fs.renameSync(tmp, target);
`;

function runWorkers(dir, workerSrc, workerArgsFor) {
  const workerPath = path.join(dir, 'worker.cjs');
  fs.writeFileSync(workerPath, workerSrc);
  const kids = [];
  for (let i = 0; i < WORKERS; i++) {
    kids.push(new Promise((resolve, reject) => {
      require('child_process').execFile(
        process.execPath, [workerPath, ...workerArgsFor(i)],
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve())
      );
    }));
  }
  return Promise.all(kids);
}

test('N concurrent single-show checkpoint writes all survive — no lost update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-checkpoint-concurrent-'));
  const target = path.join(dir, 'gap-audit-checkpoint.json');

  // Seed with one pre-existing show so carry-forward (an untouched id
  // surviving a concurrent write) is also proven, not just fresh adds.
  fs.writeFileSync(target, JSON.stringify({ 'seed-show': { at: '2026-08-01T00:00:00.000Z', gaps: 0 } }, null, 2));

  return runWorkers(dir, WORKER_SRC, (i) => [LIB, target, `show-${i}`]).then(() => {
    const final = JSON.parse(fs.readFileSync(target, 'utf8'));
    const ids = new Set(Object.keys(final));
    const missing = [];
    for (let i = 0; i < WORKERS; i++) if (!ids.has(`show-${i}`)) missing.push(`show-${i}`);
    assert.deepStrictEqual(missing, [], `lost ${missing.length}/${WORKERS} concurrent checkpoint updates`);
    assert.ok(ids.has('seed-show'), 'pre-existing entry must survive concurrent merges');
    assert.strictEqual(Object.keys(final).length, WORKERS + 1, 'no duplicate/extra rows');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('non-vacuous: the SAME concurrent scenario loses updates against the pre-#923 whole-object write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-checkpoint-wholeobj-'));
  const target = path.join(dir, 'gap-audit-checkpoint.json');
  fs.writeFileSync(target, JSON.stringify({ 'seed-show': { at: '2026-08-01T00:00:00.000Z', gaps: 0 } }, null, 2));

  return runWorkers(dir, WHOLE_OBJECT_WORKER_SRC, (i) => [target, `show-${i}`]).then(() => {
    const final = JSON.parse(fs.readFileSync(target, 'utf8'));
    const ids = new Set(Object.keys(final));
    const missing = [];
    for (let i = 0; i < WORKERS; i++) if (!ids.has(`show-${i}`)) missing.push(`show-${i}`);
    assert.ok(missing.length > 0, 'expected the whole-object write to lose at least one concurrent update (proves the test scenario is non-vacuous)');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
