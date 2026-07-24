import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createJsonWriteGuard, mergeArrayRecords, mergeMapRecords } = require('../../scripts/lib/json-write-guard');

let tmpDir;
let filePath;

function seed(obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-'));
  filePath = path.join(tmpDir, 'data.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mergeArrayRecords (array shape, mirrors mergeShows)', () => {
  test('two writers touching different records both survive', () => {
    const snapshot = [{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }];
    const mutatedByA = [{ id: 'a', status: 'closed' }, { id: 'b', status: 'open' }];
    const fresh = [{ id: 'a', status: 'open' }, { id: 'b', status: 'previews' }];
    const merged = mergeArrayRecords(snapshot, mutatedByA, fresh, 'id');
    assert.equal(merged.find((r) => r.id === 'a').status, 'closed');
    assert.equal(merged.find((r) => r.id === 'b').status, 'previews');
  });

  test('a new record added by a concurrent writer is preserved', () => {
    const snapshot = [{ id: 'a', status: 'open' }];
    const mutatedByA = [{ id: 'a', status: 'closed' }];
    const fresh = [{ id: 'a', status: 'open' }, { id: 'new', status: 'announced' }];
    const merged = mergeArrayRecords(snapshot, mutatedByA, fresh, 'id');
    assert.equal(merged.length, 2);
    assert.ok(merged.some((r) => r.id === 'new'));
  });
});

describe('mergeMapRecords (map shape — commercial.json/audience-buzz.json)', () => {
  test('two writers touching different keys both survive', () => {
    const snapshot = { hamilton: { recouped: false }, wicked: { recouped: false } };
    const mutatedByA = { hamilton: { recouped: true }, wicked: { recouped: false } };
    const fresh = { hamilton: { recouped: false }, wicked: { recouped: true } };
    const merged = mergeMapRecords(snapshot, mutatedByA, fresh);
    assert.equal(merged.hamilton.recouped, true, "A's change to hamilton survives");
    assert.equal(merged.wicked.recouped, true, "B's change to wicked is not clobbered");
  });

  test('a new key added by a concurrent writer is preserved', () => {
    const snapshot = { hamilton: { recouped: false } };
    const mutatedByA = { hamilton: { recouped: true } };
    const fresh = { hamilton: { recouped: false }, wicked: { recouped: false } };
    const merged = mergeMapRecords(snapshot, mutatedByA, fresh);
    assert.equal(Object.keys(merged).length, 2);
    assert.ok('wicked' in merged);
    assert.equal(merged.hamilton.recouped, true);
  });

  test('a key removed by this caller is removed from the merge', () => {
    const snapshot = { hamilton: {}, wicked: {} };
    const mutatedByA = { wicked: {} }; // A deleted hamilton
    const fresh = { hamilton: {}, wicked: { recouped: true } }; // B changed wicked meanwhile
    const merged = mergeMapRecords(snapshot, mutatedByA, fresh);
    assert.ok(!('hamilton' in merged));
    assert.equal(merged.wicked.recouped, true);
  });

  test('same key touched by both writers: this save wins for that key (documented limit)', () => {
    const snapshot = { hamilton: { field: 'orig' } };
    const mutatedByA = { hamilton: { field: 'from-A' } };
    const fresh = { hamilton: { field: 'from-B' } };
    const merged = mergeMapRecords(snapshot, mutatedByA, fresh);
    assert.equal(merged.hamilton.field, 'from-A');
  });
});

describe('load/save round trip — array shape', () => {
  test('saves a mutation made in place on the loaded object', () => {
    seed({ _meta: {}, shows: [{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }] });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'array', idKey: 'id' });
    const data = guard.load();
    data.shows.find((s) => s.id === 'a').status = 'closed';
    guard.save(data);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.shows.find((s) => s.id === 'a').status, 'closed');
    assert.equal(onDisk.shows.find((s) => s.id === 'b').status, 'open');
  });
});

describe('load/save round trip — map shape', () => {
  test('saves a mutation made in place on the loaded object', () => {
    seed({ _meta: {}, modelLastRun: '2026-01-01', shows: { hamilton: { recouped: false }, wicked: { recouped: false } } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    const data = guard.load();
    data.shows.hamilton.recouped = true;
    guard.save(data);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.shows.hamilton.recouped, true);
    assert.equal(onDisk.shows.wicked.recouped, false);
    // Untouched top-level scalar field survives.
    assert.equal(onDisk.modelLastRun, '2026-01-01');
  });

  test('no-snapshot write (fresh object, not from load()) still writes safely', () => {
    seed({ shows: { hamilton: { recouped: false } } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    guard.save({ shows: { hamilton: { recouped: true } } });
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.shows.hamilton.recouped, true);
  });

  test('concurrent-writer simulation: two loads before either save, no field-level data loss', () => {
    seed({ _meta: {}, shows: { hamilton: { runtime: null }, wicked: { images: [] } } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });

    const dataA = guard.load();
    const dataB = guard.load();
    dataA.shows.hamilton.runtime = '2h45m';
    dataB.shows.wicked.images = ['poster.jpg'];

    guard.save(dataA);
    guard.save(dataB);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.shows.hamilton.runtime, '2h45m', "A's write must not be lost");
    assert.deepEqual(onDisk.shows.wicked.images, ['poster.jpg'], "B's write must not be lost");
  });

  test('a scalar top-level field this caller changed overrides fresh', () => {
    seed({ _meta: {}, modelLastRun: '2026-01-01', shows: { hamilton: {} } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    const data = guard.load();
    data.modelLastRun = '2026-02-01';
    guard.save(data);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.modelLastRun, '2026-02-01');
  });
});

describe('lock serializes real concurrent processes (map shape)', () => {
  test('two child processes racing to save both land without corrupting the file', () => {
    seed({ _meta: {}, shows: { 'show-a': { field: 0 }, 'show-b': { field: 0 } } });

    const guardPath = require.resolve('../../scripts/lib/json-write-guard.js');
    const workerScript = `
      const { createJsonWriteGuard } = require(${JSON.stringify(guardPath)});
      const guard = createJsonWriteGuard(${JSON.stringify(filePath)}, { recordsKey: 'shows', shape: 'map' });
      const data = guard.load();
      data.shows[process.argv[2]].field = process.argv[3];
      const start = Date.now();
      while (Date.now() - start < 250) {}
      guard.save(data);
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
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(Object.keys(onDisk.shows).length, 2);
      assert.equal(onDisk.shows['show-a'].field, 'from-A');
      assert.equal(onDisk.shows['show-b'].field, 'from-B');
    });
  });
});

describe('repeated save() on the same object (checkpointing loop)', () => {
  test("a second save on the same object does not revert the first save's merge", () => {
    seed({ shows: { a: { field: 0 } } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    const data = guard.load();

    const other = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' }).load();
    other.shows['concurrent-add'] = {};
    createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' }).save(other);

    data.shows.a.field = 1;
    guard.save(data);
    let onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok('concurrent-add' in onDisk.shows, 'first save must merge the concurrent add');

    data.shows.a.field = 2;
    guard.save(data);
    onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok('concurrent-add' in onDisk.shows, 'second save must not silently drop the earlier merge');
    assert.equal(onDisk.shows.a.field, 2);
  });
});

describe('shrink guard integration (map shape)', () => {
  test('save refuses a >5% shrink without allowShrink', () => {
    const shows = {};
    for (let i = 0; i < 100; i++) shows[`s-${i}`] = { i };
    seed({ shows });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    const data = guard.load();
    for (let i = 0; i < 50; i++) delete data.shows[`s-${i}`];
    assert.throws(() => guard.save(data));
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(Object.keys(onDisk.shows).length, 100, 'refused write must leave the file untouched');
  });

  test('save allows a >5% shrink with allowShrink: true', () => {
    const shows = {};
    for (let i = 0; i < 100; i++) shows[`s-${i}`] = { i };
    seed({ shows });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    const data = guard.load();
    for (let i = 0; i < 50; i++) delete data.shows[`s-${i}`];
    guard.save(data, { allowShrink: true });
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(Object.keys(onDisk.shows).length, 50);
  });
});

describe('lock cleanup', () => {
  test('lock directory does not survive a successful save', () => {
    seed({ shows: { a: {} } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    const data = guard.load();
    guard.save(data);
    assert.equal(fs.existsSync(guard.lockDir), false);
  });

  test('a stale lock (past TTL) is broken automatically instead of hanging forever', () => {
    seed({ shows: { a: {} } });
    const guard = createJsonWriteGuard(filePath, { recordsKey: 'shows', shape: 'map' });
    fs.mkdirSync(guard.lockDir);
    const ownerPath = path.join(guard.lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: 999999, acquiredAt: 'stale' }));
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(ownerPath, old, old);

    const data = guard.load();
    guard.save(data); // must not hang/throw — stale lock gets broken
    assert.equal(fs.existsSync(guard.lockDir), false);
  });
});
