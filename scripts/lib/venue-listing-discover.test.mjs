// Concurrency tests for scripts/lib/venue-listing-discover.js's staging
// read-modify-write (BRO-158, "OB discovery S5: ob-venue-candidates.json
// concurrency — the #788 class").
//
// data/audit/ob-venue-candidates.json has 4 independent producers
// (discover-new-shows.js's OB venue fan-out, add-requested-show.js,
// extract-aggregator-candidates.js, promote-ob-venue-candidates.js) that
// each used to do a plain read-modify-write with no coordination — a
// classic lost-update race, same shape as #893/#923 on
// show-review-gap.json. writeStagingCandidates/updateStaging now serialize
// through scripts/lib/file-lock.js's withFileLock (same fix as
// gap-audit-merge.js). These tests spawn REAL concurrent child processes
// (like scripts/lib/file-lock.test.mjs's own racing test) against a scratch
// staging file — never the committed data/audit/ob-venue-candidates.json —
// via the stagingPath override added alongside the lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('./venue-listing-discover.js', import.meta.url));
const { loadStaging, updateStaging, candidateHash } = require('./venue-listing-discover.js');

function tmpStagingPath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'ob-venue-candidates.json');
}

function execFileP(...args) {
  return new Promise((resolve, reject) => {
    execFile(...args, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
}

test('writeStagingCandidates: N concurrent producers all land — no lost updates (the #788 class)', async () => {
  const stagingPath = tmpStagingPath('venue-staging-race-');
  const worker = path.join(path.dirname(stagingPath), 'writer.cjs');
  fs.writeFileSync(worker, `
    const { writeStagingCandidates } = require(${JSON.stringify(LIB)});
    const [, , stagingPath, title] = process.argv;
    writeStagingCandidates([{ title, venue: 'Test Venue', source: 'test' }], stagingPath);
  `);

  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    execFileP(process.execPath, [worker, stagingPath, `Concurrent Show ${i}`])
  ));

  const final = loadStaging(stagingPath);
  assert.strictEqual(final.length, N, `expected all ${N} concurrent producers' candidates to land, got ${final.length} — a read-modify-write race dropped some`);
  const titles = new Set(final.map((c) => c.title));
  for (let i = 0; i < N; i++) {
    assert.ok(titles.has(`Concurrent Show ${i}`), `candidate from producer ${i} is missing — lost update`);
  }
  fs.rmSync(path.dirname(stagingPath), { recursive: true, force: true });
});

test('writeStagingCandidates: concurrent writers touching the SAME candidate hash converge (not duplicated, not lost)', async () => {
  const stagingPath = tmpStagingPath('venue-staging-samehash-');
  const worker = path.join(path.dirname(stagingPath), 'writer.cjs');
  fs.writeFileSync(worker, `
    const { writeStagingCandidates } = require(${JSON.stringify(LIB)});
    const [, , stagingPath, evidence] = process.argv;
    writeStagingCandidates([{ title: 'Shared Show', venue: 'Shared Venue', source: 'test', evidence }], stagingPath);
  `);

  const N = 6;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    execFileP(process.execPath, [worker, stagingPath, `pass-${i}`])
  ));

  const final = loadStaging(stagingPath);
  assert.strictEqual(final.length, 1, 'the same candidateHash must collapse to one entry, not duplicate or vanish under concurrent writers');
  assert.strictEqual(final[0].candidateHash, candidateHash({ title: 'Shared Show', venue: 'Shared Venue' }));
  fs.rmSync(path.dirname(stagingPath), { recursive: true, force: true });
});

test('updateStaging: a throwing mutateFn does not corrupt or drop existing entries', () => {
  const stagingPath = tmpStagingPath('venue-staging-fail-');
  const seed = [{
    title: 'Existing Show', venue: 'Existing Venue', source: 'seed',
    candidateHash: candidateHash({ title: 'Existing Show', venue: 'Existing Venue' }),
  }];
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
  fs.writeFileSync(stagingPath, JSON.stringify(seed, null, 2));

  assert.throws(
    () => updateStaging(() => { throw new Error('simulated producer failure'); }, stagingPath),
    /simulated producer failure/
  );

  const after = loadStaging(stagingPath);
  assert.deepStrictEqual(after, seed, 'a failed producer must not corrupt or blank out valid existing entries');
  assert.strictEqual(fs.existsSync(`${stagingPath}.lock`), false, 'the lock must be released even when mutateFn throws');
  fs.rmSync(path.dirname(stagingPath), { recursive: true, force: true });
});

test('a failing concurrent producer loses only its own update, not the others in flight', async () => {
  const stagingPath = tmpStagingPath('venue-staging-mixed-');
  const dir = path.dirname(stagingPath);
  const okWorker = path.join(dir, 'ok-writer.cjs');
  fs.writeFileSync(okWorker, `
    const { writeStagingCandidates } = require(${JSON.stringify(LIB)});
    const [, , stagingPath, title] = process.argv;
    writeStagingCandidates([{ title, venue: 'Test Venue', source: 'test' }], stagingPath);
  `);
  const failWorker = path.join(dir, 'fail-writer.cjs');
  fs.writeFileSync(failWorker, `
    const { updateStaging } = require(${JSON.stringify(LIB)});
    const [, , stagingPath] = process.argv;
    updateStaging(() => { throw new Error('simulated failure'); }, stagingPath);
  `);

  const N = 5;
  const tasks = Array.from({ length: N }, (_, i) =>
    execFileP(process.execPath, [okWorker, stagingPath, `Mixed Show ${i}`])
  );
  // The failing producer's own process exits non-zero (an uncaught throw) —
  // expected, and irrelevant to what this test asserts: that its failure
  // doesn't corrupt or wipe the concurrently-written valid entries.
  tasks.push(execFileP(process.execPath, [failWorker, stagingPath]).catch(() => 'expected-failure'));

  await Promise.all(tasks);

  const final = loadStaging(stagingPath);
  assert.strictEqual(final.length, N, `a concurrent failure must not revert or drop the other producers' successful writes, got ${final.length}`);
  const titles = new Set(final.map((c) => c.title));
  for (let i = 0; i < N; i++) {
    assert.ok(titles.has(`Mixed Show ${i}`));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
