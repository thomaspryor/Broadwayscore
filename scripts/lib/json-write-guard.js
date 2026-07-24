/**
 * File-shape-agnostic version of the shows-write-guard lock+merge pattern.
 *
 * shows-write-guard.js (see its docstring) fixed the local-concurrency race
 * for data/shows.json: two same-machine scripts that both load a JSON file
 * then save it can clobber each other's changes on the second save. That gap
 * is generic to any core-data file with many independent writer scripts —
 * commercial.json (31 writers) and audience-buzz.json (33 writers) have the
 * exact same shape of bug, just unfixed (Notion card: generalize
 * shows-write-guard.js). This module extracts the lock+merge factory so
 * those two files (and any future one) get it without copy-pasting.
 *
 * Two record shapes are supported, since shows.json and commercial.json/
 * audience-buzz.json differ here:
 *   - 'array': records live in an array, each with an id field (shows.json:
 *     `{ shows: [{ id, ... }, ...] }`).
 *   - 'map': records live in a plain object keyed by id (commercial.json/
 *     audience-buzz.json: `{ shows: { [slug]: {...} } }`).
 *
 * Usage:
 *   const { createJsonWriteGuard } = require('./lib/json-write-guard');
 *   const { load, save } = createJsonWriteGuard(COMMERCIAL_PATH, {
 *     recordsKey: 'shows',
 *     shape: 'map',
 *   });
 *   const data = load();
 *   data.shows['hamilton'].recouped = true;
 *   save(data);
 *
 * Merge is whole-record granularity keyed by id: if two concurrent writers
 * both touch the SAME record, the second save wins for that record (no worse
 * than before). Different records never collide. Non-record top-level keys
 * (e.g. `_meta`, `modelLastRun`, `lastUpdated`) are merged individually: a
 * key this caller didn't change is taken from the fresh on-disk copy; a key
 * this caller DID change is applied on top (shallow-merged if both sides are
 * plain objects, e.g. `_meta`).
 */

const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteJson } = require('./atomic-shows-write');

const LOCK_STALE_MS = 60_000; // a single save should never legitimately hold this long
const LOCK_POLL_MS = 100;
const LOCK_MAX_WAIT_MS = 30_000;

function readJsonRaw(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Synchronous sleep without burning CPU in a spin loop. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerPath(lockDir) {
  return require('path').join(lockDir, 'owner.json');
}

/**
 * Acquires the lock and returns a unique token identifying THIS acquisition.
 * releaseLock() must be called with that exact token, and only removes the
 * lock if it still owns it — see shows-write-guard.js's docstring for the
 * split-brain rationale (identical logic here, kept in sync intentionally).
 */
function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    const token = crypto.randomUUID();
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        lockOwnerPath(lockDir),
        JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })
      );
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Break a stale lock (crashed holder never released it).
      try {
        const stat = fs.statSync(lockOwnerPath(lockDir));
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue; // retry immediately, no sleep
        }
      } catch {
        // owner.json missing/racing with another acquirer's mkdir — fall
        // through to the wait below instead of treating this as stale.
      }

      if (Date.now() > deadline) {
        throw new Error(
          `json-write-guard: timed out after ${LOCK_MAX_WAIT_MS}ms waiting for lock at ${lockDir}`
        );
      }
      sleepMs(LOCK_POLL_MS);
    }
  }
}

function isLockOwner(lockDir, token) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), 'utf8'));
    return owner.token === token;
  } catch {
    return false;
  }
}

function releaseLock(lockDir, token) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), 'utf8'));
    if (owner.token !== token) return; // not ours anymore — a waiter broke it as stale; leave it alone
  } catch {
    return; // already gone
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
}

/** Deep-enough equality for record objects — JSON round-trip is fine, they're plain data. */
function sameRecord(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Array-of-{id,...} merge — records identified by `record[idKey]`. */
function mergeArrayRecords(snapshotList, mutatedList, freshList, idKey) {
  const snapshotById = new Map(snapshotList.map((r) => [r[idKey], r]));
  const mutatedById = new Map(mutatedList.map((r) => [r[idKey], r]));
  const freshById = new Map(freshList.map((r) => [r[idKey], r]));

  const removedIds = new Set();
  for (const id of snapshotById.keys()) {
    if (!mutatedById.has(id)) removedIds.add(id);
  }

  const changedOrAddedIds = new Set();
  for (const [id, record] of mutatedById) {
    const orig = snapshotById.get(id);
    if (!orig || !sameRecord(orig, record)) changedOrAddedIds.add(id);
  }

  const mergedById = new Map(freshById);
  for (const id of changedOrAddedIds) mergedById.set(id, mutatedById.get(id));
  for (const id of removedIds) mergedById.delete(id);

  const order = freshList.map((r) => r[idKey]);
  for (const id of mergedById.keys()) {
    if (!order.includes(id)) order.push(id);
  }

  return order.filter((id) => mergedById.has(id)).map((id) => mergedById.get(id));
}

/** Object-map-keyed-by-id merge — same semantics as mergeArrayRecords, map shape. */
function mergeMapRecords(snapshotMap, mutatedMap, freshMap) {
  const removedKeys = new Set();
  for (const key of Object.keys(snapshotMap)) {
    if (!(key in mutatedMap)) removedKeys.add(key);
  }

  const changedOrAddedKeys = new Set();
  for (const key of Object.keys(mutatedMap)) {
    const orig = snapshotMap[key];
    if (orig === undefined || !sameRecord(orig, mutatedMap[key])) changedOrAddedKeys.add(key);
  }

  const merged = { ...freshMap };
  for (const key of changedOrAddedKeys) merged[key] = mutatedMap[key];
  for (const key of removedKeys) delete merged[key];
  return merged;
}

function mergeRecords(shape, idKey, snapshot, mutated, fresh) {
  if (shape === 'array') return mergeArrayRecords(snapshot, mutated, fresh, idKey);
  return mergeMapRecords(snapshot, mutated, fresh);
}

function recordCount(shape, records) {
  return shape === 'array' ? records.length : Object.keys(records).length;
}

function recordsEqual(shape, idKey, a, b) {
  if (shape === 'array') {
    return (
      a.length === b.length &&
      JSON.stringify(a.map((r) => r[idKey])) === JSON.stringify(b.map((r) => r[idKey])) &&
      a.every((r, i) => sameRecord(r, b[i]))
    );
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => k in b) &&
    aKeys.every((k) => sameRecord(a[k], b[k]))
  );
}

/**
 * Build a load/save pair bound to a specific JSON file.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {object} opts
 * @param {string} [opts.recordsKey='shows'] - Top-level key holding the
 *   mergeable collection.
 * @param {'array'|'map'} [opts.shape='array'] - Whether `data[recordsKey]` is
 *   an array of records with an id field, or a plain object keyed by id.
 * @param {string} [opts.idKey='id'] - Id field name (array shape only).
 * @param {string} [opts.metaKey='_meta'] - Top-level metadata key that gets
 *   an auto-stamped `lastUpdated` on every save (set to null to disable).
 * @param {(finalData: object) => void} [opts.beforeWrite] - Optional hook run
 *   on the fully-merged object right before the atomic write, for a wrapper
 *   that needs to stamp an extra file-specific field (e.g. shows.json's
 *   `_meta.totalShows`).
 */
function createJsonWriteGuard(filePath, opts = {}) {
  const recordsKey = opts.recordsKey || 'shows';
  const shape = opts.shape || 'array';
  const idKey = opts.idKey || 'id';
  const metaKey = opts.metaKey === undefined ? '_meta' : opts.metaKey;
  const beforeWrite = typeof opts.beforeWrite === 'function' ? opts.beforeWrite : null;
  const lockDir = `${filePath}.lock`;
  // Tracks the as-loaded snapshot for each object load() has handed out, so
  // save() can tell what THIS caller actually changed.
  const snapshots = new WeakMap();

  function load() {
    const data = readJsonRaw(filePath);
    snapshots.set(data, JSON.parse(JSON.stringify(data)));
    return data;
  }

  /**
   * Save under an exclusive lock. Re-reads the file after acquiring the
   * lock and merges this caller's changes onto whatever's current, by
   * record id, before writing.
   *
   * @param {object} data - The file's object (as returned by load()).
   * @param {object} [options]
   * @param {boolean} [options.allowShrink] - Forwarded to atomicWriteJson;
   *   pass when the caller is deliberately deleting records.
   */
  function save(data, options = {}) {
    const lockToken = acquireLock(lockDir);
    try {
      const snapshot = snapshots.get(data);
      let finalData = data;

      if (snapshot) {
        const fresh = readJsonRaw(filePath);
        const freshChanged = !recordsEqual(shape, idKey, fresh[recordsKey], snapshot[recordsKey]);

        if (freshChanged) {
          const mergedRecords = mergeRecords(shape, idKey, snapshot[recordsKey], data[recordsKey], fresh[recordsKey]);
          finalData = { ...fresh, [recordsKey]: mergedRecords };
          // Any other top-level key this caller changed (vs its own
          // snapshot) is applied on top of fresh's current value — shallow
          // merged if both sides are plain objects (e.g. _meta), otherwise
          // overwritten outright (e.g. a scalar lastUpdated string).
          for (const key of Object.keys(data)) {
            if (key === recordsKey) continue;
            const changed = !(key in snapshot) || JSON.stringify(data[key]) !== JSON.stringify(snapshot[key]);
            if (!changed) continue;
            finalData[key] = isPlainObject(data[key]) && isPlainObject(fresh[key])
              ? { ...fresh[key], ...data[key] }
              : data[key];
          }
        }
      }

      if (metaKey) {
        finalData[metaKey] = finalData[metaKey] || {};
        finalData[metaKey].lastUpdated = new Date().toISOString();
      }

      if (beforeWrite) beforeWrite(finalData);

      // Re-verify ownership right before writing — see shows-write-guard.js
      // for why (a waiter may have broken our lock as stale while we were
      // still legitimately working).
      if (!isLockOwner(lockDir, lockToken)) {
        throw new Error(
          `json-write-guard: lock for ${filePath} was broken as stale (held past ${LOCK_STALE_MS}ms) — aborting save to avoid racing the new holder`
        );
      }

      const result = atomicWriteJson(filePath, finalData, options);

      // Sync the caller's object to the written (possibly merged) state —
      // see shows-write-guard.js for why this matters for checkpointing
      // callers that save() the same object twice in a loop.
      if (finalData !== data) {
        data[recordsKey] = finalData[recordsKey];
        for (const key of Object.keys(finalData)) {
          if (key !== recordsKey) data[key] = finalData[key];
        }
      }
      snapshots.set(data, JSON.parse(JSON.stringify(finalData)));
      return result;
    } finally {
      releaseLock(lockDir, lockToken);
    }
  }

  return { load, save, filePath, lockDir, recordsKey, shape, idKey };
}

module.exports = {
  createJsonWriteGuard,
  mergeArrayRecords,
  mergeMapRecords,
  recordCount,
};
