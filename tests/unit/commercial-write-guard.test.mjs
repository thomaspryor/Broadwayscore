import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createCommercialWriteGuard } = require('../../scripts/lib/commercial-write-guard');

let tmpDir;
let commercialPath;

function seed(obj) {
  fs.writeFileSync(commercialPath, JSON.stringify(obj, null, 2) + '\n');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-write-guard-'));
  commercialPath = path.join(tmpDir, 'commercial.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadCommercial/saveCommercial round trip', () => {
  test('saves a mutation made in place on the loaded object (map shape, keyed by slug)', () => {
    seed({
      _meta: { description: 'Biz Buzz' },
      modelLastRun: '2026-07-18',
      shows: { hamilton: { recouped: false }, wicked: { recouped: false } },
    });
    const guard = createCommercialWriteGuard(commercialPath);

    const data = guard.loadCommercial();
    data.shows.hamilton.recouped = true;
    guard.saveCommercial(data);

    const onDisk = JSON.parse(fs.readFileSync(commercialPath, 'utf8'));
    assert.equal(onDisk.shows.hamilton.recouped, true);
    assert.equal(onDisk.shows.wicked.recouped, false);
    assert.equal(onDisk.modelLastRun, '2026-07-18', 'untouched top-level field survives');
  });
});

describe('concurrent-writer simulation (load/load/save/save interleave)', () => {
  test('no field-level data loss when two writers overlap on different shows', () => {
    seed({ _meta: {}, shows: { hamilton: { recoupedDate: null }, wicked: { images: [] } } });
    const guard = createCommercialWriteGuard(commercialPath);

    const dataA = guard.loadCommercial();
    const dataB = guard.loadCommercial();

    dataA.shows.hamilton.recoupedDate = '2016-03';
    dataB.shows.wicked.images = ['poster.jpg'];

    guard.saveCommercial(dataA);
    guard.saveCommercial(dataB);

    const onDisk = JSON.parse(fs.readFileSync(commercialPath, 'utf8'));
    assert.equal(onDisk.shows.hamilton.recoupedDate, '2016-03', "A's write must not be lost");
    assert.deepEqual(onDisk.shows.wicked.images, ['poster.jpg'], "B's write must not be lost");
  });
});

describe('lock serializes real concurrent processes', () => {
  test('two child processes racing to save both land without corrupting the file', () => {
    seed({ _meta: {}, shows: { 'show-a': { field: 0 }, 'show-b': { field: 0 } } });

    const guardPath = require.resolve('../../scripts/lib/commercial-write-guard.js');
    const workerScript = `
      const { createCommercialWriteGuard } = require(${JSON.stringify(guardPath)});
      const guard = createCommercialWriteGuard(${JSON.stringify(commercialPath)});
      const data = guard.loadCommercial();
      data.shows[process.argv[2]].field = process.argv[3];
      const start = Date.now();
      while (Date.now() - start < 250) {}
      guard.saveCommercial(data);
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
      const onDisk = JSON.parse(fs.readFileSync(commercialPath, 'utf8'));
      assert.equal(Object.keys(onDisk.shows).length, 2);
      assert.equal(onDisk.shows['show-a'].field, 'from-A');
      assert.equal(onDisk.shows['show-b'].field, 'from-B');
    });
  });
});
