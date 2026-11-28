import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createAudienceBuzzWriteGuard } = require('../../scripts/lib/audience-buzz-write-guard');

let tmpDir;
let abPath;

function seed(obj) {
  fs.writeFileSync(abPath, JSON.stringify(obj, null, 2) + '\n');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audience-buzz-write-guard-'));
  abPath = path.join(tmpDir, 'audience-buzz.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadAudienceBuzz/saveAudienceBuzz round trip', () => {
  test('saves a mutation made in place on the loaded object (map shape, keyed by show id)', () => {
    seed({
      _meta: { sources: ['Show Score'] },
      lastUpdated: '2026-06-30T21:19:27.575Z',
      shows: { 'hamilton-2015': { combinedScore: 95.2 }, 'wicked-2003': { combinedScore: 88 } },
    });
    const guard = createAudienceBuzzWriteGuard(abPath);

    const data = guard.loadAudienceBuzz();
    data.shows['hamilton-2015'].combinedScore = 96;
    guard.saveAudienceBuzz(data);

    const onDisk = JSON.parse(fs.readFileSync(abPath, 'utf8'));
    assert.equal(onDisk.shows['hamilton-2015'].combinedScore, 96);
    assert.equal(onDisk.shows['wicked-2003'].combinedScore, 88);
    assert.equal(onDisk.lastUpdated, '2026-06-30T21:19:27.575Z', 'untouched top-level field survives');
  });
});

describe('concurrent-writer simulation (load/load/save/save interleave)', () => {
  test('no field-level data loss when two writers overlap on different shows', () => {
    seed({ _meta: {}, shows: { 'hamilton-2015': { sources: {} }, 'wicked-2003': { sources: {} } } });
    const guard = createAudienceBuzzWriteGuard(abPath);

    const dataA = guard.loadAudienceBuzz();
    const dataB = guard.loadAudienceBuzz();

    dataA.shows['hamilton-2015'].sources.reddit = { score: 80 };
    dataB.shows['wicked-2003'].sources.mezzanine = { score: 93 };

    guard.saveAudienceBuzz(dataA);
    guard.saveAudienceBuzz(dataB);

    const onDisk = JSON.parse(fs.readFileSync(abPath, 'utf8'));
    assert.deepEqual(onDisk.shows['hamilton-2015'].sources.reddit, { score: 80 }, "A's write must not be lost");
    assert.deepEqual(onDisk.shows['wicked-2003'].sources.mezzanine, { score: 93 }, "B's write must not be lost");
  });
});

describe('lock serializes real concurrent processes', () => {
  test('two child processes racing to save both land without corrupting the file', () => {
    seed({ _meta: {}, shows: { 'show-a': { field: 0 }, 'show-b': { field: 0 } } });

    const guardPath = require.resolve('../../scripts/lib/audience-buzz-write-guard.js');
    const workerScript = `
      const { createAudienceBuzzWriteGuard } = require(${JSON.stringify(guardPath)});
      const guard = createAudienceBuzzWriteGuard(${JSON.stringify(abPath)});
      const data = guard.loadAudienceBuzz();
      data.shows[process.argv[2]].field = process.argv[3];
      const start = Date.now();
      while (Date.now() - start < 250) {}
      guard.saveAudienceBuzz(data);
    `;
    const workerPath = path.join(tmpDir, 'worker.js');
    fs.writeFileSync(workerPath, workerScript);

    const { spawn } = require('child_process');
    const runWorker = (id, value) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, id, value], { stdio: 'inherit' });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      });

    return Promise.all([runWorker('show-a', 'from-A'), runWorker('show-b', 'from-B')]).then(() => {
      const onDisk = JSON.parse(fs.readFileSync(abPath, 'utf8'));
      assert.equal(Object.keys(onDisk.shows).length, 2);
      assert.equal(onDisk.shows['show-a'].field, 'from-A');
      assert.equal(onDisk.shows['show-b'].field, 'from-B');
    });
  });
});
