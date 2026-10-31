import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isLockStale, lockOwnerPath, LOCK_STALE_MS, createJsonWriteGuard } = require('./json-write-guard.js');

function mkLockDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-lock-'));
}

function writeOwner(dir, obj) {
  fs.writeFileSync(lockOwnerPath(dir), JSON.stringify(obj));
}

test('#485 repro: a stale acquiredAt is judged stale even when the lock dir/file mtime was touched just now', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString() });
  fs.utimesSync(dir, new Date(), new Date()); // simulate an unrelated process touching the lock dir
  fs.utimesSync(lockOwnerPath(dir), new Date(), new Date()); // and the owner.json file itself
  assert.equal(isLockStale(dir), true);
});

test('a fresh acquiredAt reads not-stale', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date().toISOString() });
  assert.equal(isLockStale(dir), false);
});

test('exactly at the boundary is not stale; just past it is stale', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date(Date.now() - LOCK_STALE_MS + 1000).toISOString() });
  assert.equal(isLockStale(dir), false);
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() });
  assert.equal(isLockStale(dir), true);
});

test('missing owner.json throws — caller treats that as "cannot tell, do not break the lock"', () => {
  const dir = mkLockDir();
  assert.throws(() => isLockStale(dir));
});

test('corrupt owner.json content falls back to mtime: old mtime reads stale', () => {
  const dir = mkLockDir();
  fs.writeFileSync(lockOwnerPath(dir), 'not json');
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lockOwnerPath(dir), old, old);
  assert.equal(isLockStale(dir), true);
});

test('corrupt owner.json content falls back to mtime: fresh mtime reads not stale', () => {
  const dir = mkLockDir();
  fs.writeFileSync(lockOwnerPath(dir), 'not json');
  assert.equal(isLockStale(dir), false);
});

test('owner.json missing the acquiredAt field (old format) falls back to mtime', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a' });
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lockOwnerPath(dir), old, old);
  assert.equal(isLockStale(dir), true);
});

test('a malformed acquiredAt string falls back to mtime instead of throwing', () => {
  const dir = mkLockDir();
  writeOwner(dir, { pid: 1, token: 'a', acquiredAt: 'not-a-date' });
  assert.doesNotThrow(() => isLockStale(dir));
});

test('a nonexistent lock dir throws (same as a bare statSync would)', () => {
  assert.throws(() => isLockStale('/tmp/does-not-exist-json-write-guard-485'));
});

test('integration: createJsonWriteGuard.save() breaks a stale lock via acquiredAt even though the dir mtime was just touched', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-int-'));
  const filePath = path.join(tmpDir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify({ shows: [], _meta: {} }));
  const lockDir = `${filePath}.lock`;
  fs.mkdirSync(lockDir);
  writeOwner(lockDir, {
    pid: 999999,
    token: 'dead-holder',
    acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString(),
  });
  fs.utimesSync(lockDir, new Date(), new Date()); // an unrelated touch — must not keep this lock alive

  const guard = createJsonWriteGuard(filePath, { shape: 'array' });
  const data = guard.load();
  data.shows.push({ id: 'x', foo: 1 });
  assert.doesNotThrow(() => guard.save(data));

  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.shows.length, 1);
});

// BRO-4726: fetch-tour-images.js held references to show objects across
// several save() calls. save() used to swap every record it had not changed
// for a freshly parsed copy, so edits made through the old references after
// the first save were silently dropped (15 tours updated, 1 persisted).
for (const shape of ['array', 'map']) {
  test(`${shape}: a record reference held across save() calls keeps writing through`, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-ref-'));
    const filePath = path.join(tmpDir, 'data.json');
    const records = shape === 'array'
      ? [{ id: 'a', v: 0 }, { id: 'b', v: 0 }, { id: 'c', v: 0 }]
      : { a: { v: 0 }, b: { v: 0 }, c: { v: 0 } };
    fs.writeFileSync(filePath, JSON.stringify({ shows: records, _meta: {} }));
    const guard = createJsonWriteGuard(filePath, { shape, idKey: 'id', metaKey: '_meta' });
    const data = guard.load();
    const held = ['a', 'b', 'c'].map(id => (shape === 'array' ? data.shows.find(s => s.id === id) : data.shows[id]));
    const container = data.shows;
    for (const rec of held) { rec.v = 1; guard.save(data); }
    assert.equal(data.shows, container, 'the records container keeps its identity');
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8')).shows;
    const values = shape === 'array' ? written.map(s => s.v) : ['a', 'b', 'c'].map(id => written[id].v);
    assert.deepEqual(values, [1, 1, 1]);
  });
}

test('a concurrent writer\'s change to a held record is copied into the caller\'s object', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-write-guard-ref-'));
  const filePath = path.join(tmpDir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify({ shows: [{ id: 'a', v: 0 }, { id: 'b', v: 0 }], _meta: {} }));
  const opts = { shape: 'array', idKey: 'id', metaKey: '_meta' };
  const guard = createJsonWriteGuard(filePath, opts);
  const data = guard.load();
  const [a, b] = data.shows;
  // Another process changes b between our load and our first save.
  const other = createJsonWriteGuard(filePath, opts);
  const theirs = other.load();
  theirs.shows[1].w = 'theirs';
  other.save(theirs);
  a.v = 1;
  guard.save(data);
  assert.equal(b.w, 'theirs', 'held object picks up the concurrent change');
  b.v = 2;
  guard.save(data);
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8')).shows;
  assert.deepEqual(written, [{ id: 'a', v: 1 }, { id: 'b', v: 2, w: 'theirs' }]);
});

for (const behavior of ['write', 'skip', 'throw', 'async']) {
  test(`mutateFresh ${behavior} uses locked current data and cleans up`, (t) => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.claude/bro3834-guard-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, JSON.stringify({ shows: [{ id: 'x', title: 'old' }], _meta: { lastUpdated: 'old' } }, null, 2));
    const guard = createJsonWriteGuard(file);
    const data = guard.load();
    data.shows[0].title = 'stale caller edit';
    data._meta.lastUpdated = 'stale caller timestamp';
    const human = createJsonWriteGuard(file);
    const fresh = human.load();
    fresh.shows[0].title = 'human title';
    fresh.humanNote = 'human top-level';
    fresh._meta.lastUpdated = 'human timestamp';
    human.save(fresh);
    const before = fs.readFileSync(file, 'utf8');
    const callback = current => {
      assert.equal(fs.existsSync(guard.lockDir), true);
      assert.equal(current.shows[0].title, 'human title');
      assert.equal(current._meta.lastUpdated, 'human timestamp');
      if (behavior === 'skip') return false;
      if (behavior === 'throw') throw new Error('abort mutation');
      if (behavior === 'async') return Promise.resolve();
      current.shows[0].closingDate = '2025-01-01';
      current._meta.lastUpdated = 'callback timestamp';
    };
    if (behavior === 'throw' || behavior === 'async') {
      assert.throws(() => guard.save(data, { mutateFresh: callback }), behavior === 'throw' ? /abort mutation/ : /synchronous/);
    } else {
      const result = guard.save(data, { mutateFresh: callback });
      if (behavior === 'skip') assert.equal(result.wrote, false);
    }
    assert.equal(fs.existsSync(guard.lockDir), false);
    if (behavior !== 'write') assert.equal(fs.readFileSync(file, 'utf8'), before);
    else {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.shows[0].title, 'human title');
      assert.equal(saved.shows[0].closingDate, '2025-01-01');
      assert.equal(saved.humanNote, 'human top-level');
      assert.equal(saved._meta.lastUpdated, 'callback timestamp');
      assert.deepEqual(data, saved);
    }
  });
}
