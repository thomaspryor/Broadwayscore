// Task #902 / #893 — the plan's S0 acceptance line: "`--show=X` twice
// CONCURRENTLY → no lost data".
//
// Back-to-back runs are the easy case and the per-show merge alone covers them.
// The hard case is two OVERLAPPING processes: both read the same prior file,
// both merge their own show into it, and the later write drops the earlier
// one's update — #893's data loss from a different cause. The GitHub
// concurrency group does not prevent this (a local terminal run can overlap the
// hourly cron), so the write path takes a real file lock.
//
// This test spawns REAL child processes, not simulated interleaving: N workers
// each read-merge-write their own showId into one file at the same time, and
// every one of them must survive.
//
// withFileLock's own mechanics (stale-break, PID liveness, fail-open, racing
// stealers) are tested in file-lock.test.mjs (task #923 — the helper moved
// there once it started guarding a second, unrelated file).
//
// Run: node --test scripts/lib/gap-audit-merge.concurrent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const LIB = path.resolve(new URL('./gap-audit-merge.js', import.meta.url).pathname);

const WORKERS = 8;

// Worker: contend for the lock, then do the same read-modify-write the audit
// does. A random-ish stagger inside the critical section widens the window a
// lost update would slip through.
const WORKER_SRC = `
const fs = require('fs');
const { mergeGapAudit, withFileLock } = require(process.argv[2]);
const target = process.argv[3];
const showId = process.argv[4];
withFileLock(target + '.lock', () => {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { prev = null; }
  // Hold the critical section open long enough that an unlocked implementation
  // would reliably interleave here.
  const until = Date.now() + 40;
  while (Date.now() < until) { /* spin */ }
  const merged = mergeGapAudit(prev, {
    generatedAt: new Date().toISOString(),
    windowDays: 21,
    targets: 1,
    results: [{ showId, title: showId, aggregatorArticles: ['https://x/a'], aggregatorListedUrls: [], missing: [], flaggedMisses: [], citedNoUrl: [] }],
  }, { retentionDays: 3650 });
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, target);
});
`;

test('N concurrent single-show runs all survive — no lost update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-concurrent-'));
  const target = path.join(dir, 'show-review-gap.json');
  const workerPath = path.join(dir, 'worker.cjs');
  fs.writeFileSync(workerPath, WORKER_SRC);

  // Seed with one pre-existing show so we also prove carry-forward survives.
  fs.writeFileSync(target, JSON.stringify({
    generatedAt: '2026-08-01T00:00:00.000Z',
    results: [{ showId: 'seed-show', missing: [], flaggedMisses: [], citedNoUrl: [], computedAt: '2026-08-01T00:00:00.000Z' }],
  }, null, 2));

  const kids = [];
  for (let i = 0; i < WORKERS; i++) {
    kids.push(new Promise((resolve, reject) => {
      require('child_process').execFile(
        process.execPath, [workerPath, LIB, target, `show-${i}`],
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve())
      );
    }));
  }
  // Synchronous test body: drain with execFileSync-style waiting via a busy
  // Promise.all is not possible, so re-run them serially is NOT what we want.
  // Instead: block on the child PIDs using a tiny wait loop over the promises.
  return Promise.all(kids).then(() => {
    const final = JSON.parse(fs.readFileSync(target, 'utf8'));
    const ids = new Set(final.results.map(r => r.showId));
    const missing = [];
    for (let i = 0; i < WORKERS; i++) if (!ids.has(`show-${i}`)) missing.push(`show-${i}`);
    assert.deepStrictEqual(missing, [], `lost ${missing.length}/${WORKERS} concurrent updates — the write path is not serialized`);
    assert.ok(ids.has('seed-show'), 'pre-existing entry must survive concurrent merges');
    assert.strictEqual(final.results.length, WORKERS + 1, 'no duplicate rows');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// keep execFileSync import used (lint): assert the lib is requireable as CJS
test('gap-audit-merge is requireable from a child process', () => {
  const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(LIB)}); console.log('ok')`], { encoding: 'utf8' });
  assert.match(out, /ok/);
});
