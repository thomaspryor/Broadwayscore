import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createShowsWriteGuard, mergeShows } = require('../../scripts/lib/shows-write-guard');

let tmpDir;
let showsPath;

function seed(shows) {
  fs.writeFileSync(
    showsPath,
    JSON.stringify({ _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' }, shows }, null, 2) + '\n'
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-write-guard-'));
  showsPath = path.join(tmpDir, 'shows.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadShows/saveShows round trip', () => {
  test('saves a mutation made in place on the loaded object', () => {
    seed([{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }]);
    const guard = createShowsWriteGuard(showsPath);

    const data = guard.loadShows();
    data.shows.find((s) => s.id === 'a').status = 'closed';
    guard.saveShows(data);

    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows.find((s) => s.id === 'a').status, 'closed');
    assert.equal(onDisk.shows.find((s) => s.id === 'b').status, 'open');
  });

  test('no-snapshot write (fresh object, not from loadShows) still writes safely', () => {
    seed([{ id: 'a', status: 'open' }]);
    const guard = createShowsWriteGuard(showsPath);
    guard.saveShows({ shows: [{ id: 'a', status: 'closed' }] });
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows.find((s) => s.id === 'a').status, 'closed');
  });
});

describe('mergeShows (concurrent-writer core logic)', () => {
  test('two writers touching different shows both survive', () => {
    const snapshot = { shows: [{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }] };
    // Writer A mutates show a, based on the same snapshot.
    const mutatedByA = { shows: [{ id: 'a', status: 'closed' }, { id: 'b', status: 'open' }] };
    // Writer B already landed its change to show b before A's save runs.
    const fresh = { shows: [{ id: 'a', status: 'open' }, { id: 'b', status: 'previews' }] };

    const merged = mergeShows(snapshot, mutatedByA, fresh);
    assert.equal(merged.find((s) => s.id === 'a').status, 'closed', "A's change to show a survives");
    assert.equal(merged.find((s) => s.id === 'b').status, 'previews', "B's change to show b is not clobbered");
  });

  test('a new show added by a concurrent writer is preserved', () => {
    const snapshot = { shows: [{ id: 'a', status: 'open' }] };
    const mutatedByA = { shows: [{ id: 'a', status: 'closed' }] };
    const fresh = { shows: [{ id: 'a', status: 'open' }, { id: 'new-show', status: 'announced' }] };

    const merged = mergeShows(snapshot, mutatedByA, fresh);
    assert.equal(merged.length, 2);
    assert.ok(merged.some((s) => s.id === 'new-show'));
    assert.equal(merged.find((s) => s.id === 'a').status, 'closed');
  });

  test('same show touched by both writers: this save wins for that show (documented limit)', () => {
    const snapshot = { shows: [{ id: 'a', status: 'open' }] };
    const mutatedByA = { shows: [{ id: 'a', status: 'closed' }] };
    const fresh = { shows: [{ id: 'a', status: 'previews' }] }; // B already changed the same show
    const merged = mergeShows(snapshot, mutatedByA, fresh);
    assert.equal(merged.find((s) => s.id === 'a').status, 'closed');
  });
});

describe('saveShows end-to-end concurrent-writer simulation (load/load/save/save interleave)', () => {
  test('no field-level data loss when two writers overlap', () => {
    seed([
      { id: 'hamilton', status: 'open', runtime: null },
      { id: 'wicked', status: 'open', images: [] },
    ]);
    const guard = createShowsWriteGuard(showsPath);

    // Both writers load BEFORE either saves — the exact race from the card.
    const dataA = guard.loadShows();
    const dataB = guard.loadShows();

    dataA.shows.find((s) => s.id === 'hamilton').runtime = '2h45m';
    dataB.shows.find((s) => s.id === 'wicked').images = ['poster.jpg'];

    guard.saveShows(dataA);
    guard.saveShows(dataB);

    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows.find((s) => s.id === 'hamilton').runtime, '2h45m', "A's write must not be lost");
    assert.deepEqual(
      onDisk.shows.find((s) => s.id === 'wicked').images,
      ['poster.jpg'],
      "B's write must not be lost"
    );
  });
});

describe('lock serializes real concurrent processes', () => {
  test('two child processes racing to save both land without corrupting the file', () => {
    seed([
      { id: 'show-a', field: 0 },
      { id: 'show-b', field: 0 },
    ]);

    const guardPath = require.resolve('../../scripts/lib/shows-write-guard.js');
    const workerScript = `
      const { createShowsWriteGuard } = require(${JSON.stringify(guardPath)});
      const guard = createShowsWriteGuard(${JSON.stringify(showsPath)});
      const data = guard.loadShows();
      const target = data.shows.find(s => s.id === process.argv[2]);
      target.field = process.argv[3];
      // Busy-wait to force overlap with the sibling process's load.
      const start = Date.now();
      while (Date.now() - start < 250) {}
      guard.saveShows(data);
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
      const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      assert.equal(onDisk.shows.length, 2);
      assert.equal(onDisk.shows.find((s) => s.id === 'show-a').field, 'from-A');
      assert.equal(onDisk.shows.find((s) => s.id === 'show-b').field, 'from-B');
    });
  });
});

describe('saveShows return value', () => {
  test('returns the atomicWriteShowsJson result ({lineCountBefore, lineCountAfter, wrote})', () => {
    seed([{ id: 'a' }]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.push({ id: 'b' });
    const result = guard.saveShows(data);
    assert.equal(result.wrote, true);
    assert.equal(typeof result.lineCountBefore, 'number');
    assert.equal(typeof result.lineCountAfter, 'number');
  });
});

describe('shrink guard integration', () => {
  test('saveShows refuses a >5% shrink without allowShrink', () => {
    seed(Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` })));
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows = data.shows.slice(0, 50);
    assert.throws(() => guard.saveShows(data));
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows.length, 100, 'refused write must leave the file untouched');
  });

  test('saveShows allows a >5% shrink with allowShrink: true', () => {
    seed(Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` })));
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows = data.shows.slice(0, 50);
    guard.saveShows(data, { allowShrink: true });
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows.length, 50);
  });
});

describe('lock cleanup', () => {
  test('lock directory does not survive a successful save', () => {
    seed([{ id: 'a' }]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    guard.saveShows(data);
    assert.equal(fs.existsSync(guard.lockDir), false);
  });

  test('a stale lock (past TTL) is broken automatically instead of hanging forever', () => {
    seed([{ id: 'a' }]);
    const guard = createShowsWriteGuard(showsPath);
    // Simulate a crashed holder: create the lock dir with an old mtime.
    fs.mkdirSync(guard.lockDir);
    const ownerPath = path.join(guard.lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: 999999, acquiredAt: 'stale' }));
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(ownerPath, old, old);

    const data = guard.loadShows();
    guard.saveShows(data); // must not hang/throw — stale lock gets broken
    assert.equal(fs.existsSync(guard.lockDir), false);
  });
});
