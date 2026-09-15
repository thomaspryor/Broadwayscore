import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// BRO-886: scripts/test-send-lock.js already exercises acquireSendLock/releaseSendLock,
// but only as a slow, live-network integration test against the real GitHub Contents
// API (real commits to origin/main's lock file). There was no fast, CI-safe unit test
// for this concurrency primitive. This file fills that gap with the same fake-`gh`-on-
// PATH pattern already used by scripts/reconcile-broadcast-state.test.mjs and
// scripts/send-opening-night-broadcast.test.mjs — but implements full compare-and-swap
// semantics (sha match/mismatch -> HTTP 409/422) since send-lock.js's acquire/release/
// takeover logic depends on that, unlike those simpler read-then-overwrite fakes.
//
// Never sends any email, never touches the real repo, never requires `gh` to be
// authenticated.

const require = createRequire(import.meta.url);
const { acquireSendLock, releaseSendLock, fetchLock } = require('./send-lock.js');

function makeFakeGh(stateFile) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-send-lock-'));
  const ghPath = path.join(binDir, 'gh');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};

function readState() {
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}
function writeState(s) { fs.writeFileSync(stateFile, JSON.stringify(s)); }
function clearState() { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); }

if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] !== 'api') process.exit(1);

const rest = args.slice(1);
const methodIdx = rest.indexOf('--method');
const method = methodIdx !== -1 ? rest[methodIdx + 1] : 'GET';
const hasStdin = rest.includes('--input') && rest[rest.indexOf('--input') + 1] === '-';

let payload = null;
if (hasStdin) {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
}

const state = readState();

if (method === 'GET') {
  if (!state) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ sha: state.sha, content: Buffer.from(state.content, 'utf8').toString('base64') }));
  process.exit(0);
}

if (method === 'PUT') {
  if (payload.sha) {
    if (!state || state.sha !== payload.sha) {
      process.stderr.write('gh: Conflict (HTTP 409)\\n');
      process.exit(1);
    }
  } else if (state) {
    process.stderr.write('gh: Unprocessable Entity (HTTP 422)\\n');
    process.exit(1);
  }
  const content = Buffer.from(payload.content, 'base64').toString('utf8');
  const newSha = 'sha-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  writeState({ content, sha: newSha });
  process.stdout.write(JSON.stringify({ content: { sha: newSha } }));
  process.exit(0);
}

if (method === 'DELETE') {
  if (!state) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  if (state.sha !== payload.sha) {
    process.stderr.write('gh: Conflict (HTTP 409)\\n');
    process.exit(1);
  }
  clearState();
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

process.exit(1);
`;
  fs.writeFileSync(ghPath, script);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

function withFakeGh(fn) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-lock-state-'));
  const stateFile = path.join(workDir, 'lock-state.json');
  const binDir = makeFakeGh(stateFile);

  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test('acquireSendLock: acquires cleanly when no lock file exists', () => {
  withFakeGh(() => {
    const lock = acquireSendLock({ purpose: 'test-happy-path', ttlMs: 5000 });
    assert.equal(lock.acquired, true, lock.reason);
    assert.equal(typeof lock.sessionId, 'string');
    assert.equal(lock.sessionId.length, 36);

    const verify = fetchLock();
    assert.equal(verify.exists, true);
    assert.equal(verify.parsed.sessionId, lock.sessionId);
    assert.equal(verify.parsed.purpose, 'test-happy-path');
  });
});

test('acquireSendLock: a second acquire for the same purpose is refused while the first is held', () => {
  withFakeGh(() => {
    const first = acquireSendLock({ purpose: 'test-contention', ttlMs: 5000 });
    assert.equal(first.acquired, true);

    const second = acquireSendLock({ purpose: 'test-contention', ttlMs: 5000 });
    assert.equal(second.acquired, false);
    assert.ok(second.reason.includes('held by'));
    assert.equal(second.heldBy.sessionId, first.sessionId);
  });
});

test('acquireSendLock: takes over an expired lock with a fresh sessionId', () => {
  withFakeGh(() => {
    const now = Date.now();
    const first = acquireSendLock({ purpose: 'test-expiry', ttlMs: 1000, now: now - 5000 });
    assert.equal(first.acquired, true);

    // First lock's expiresAt is (now - 5000) + 1000 = now - 4000, already in the past.
    const second = acquireSendLock({ purpose: 'test-expiry', ttlMs: 5000, now });
    assert.equal(second.acquired, true, second.reason);
    assert.notEqual(second.sessionId, first.sessionId);
  });
});

test('releaseSendLock: releases a held lock and it is gone from origin', () => {
  withFakeGh(() => {
    const lock = acquireSendLock({ purpose: 'test-release', ttlMs: 5000 });
    assert.equal(lock.acquired, true);

    const rel = releaseSendLock(lock);
    assert.equal(rel.released, true);

    const verify = fetchLock();
    assert.equal(verify.exists, false);
  });
});

test('releaseSendLock: refuses when the lock has been taken over by someone else (stale sessionId)', () => {
  withFakeGh(() => {
    const now = Date.now();
    const original = acquireSendLock({ purpose: 'test-takeover-release', ttlMs: 1000, now: now - 5000 });
    assert.equal(original.acquired, true);

    // A new holder takes over the expired lock.
    const takenOver = acquireSendLock({ purpose: 'test-takeover-release', ttlMs: 5000, now });
    assert.equal(takenOver.acquired, true);
    assert.notEqual(takenOver.sessionId, original.sessionId);

    // The ORIGINAL holder's release must not be able to nuke the new holder's lock.
    const relOriginal = releaseSendLock(original);
    assert.equal(relOriginal.released, false);
    assert.ok(relOriginal.reason.includes('taken over'));

    // New holder's lock is still intact.
    const verify = fetchLock();
    assert.equal(verify.exists, true);
    assert.equal(verify.parsed.sessionId, takenOver.sessionId);
  });
});

test('releaseSendLock: idempotent — releasing an already-released lock reports success', () => {
  withFakeGh(() => {
    const lock = acquireSendLock({ purpose: 'test-idempotent', ttlMs: 5000 });
    assert.equal(lock.acquired, true);

    const first = releaseSendLock(lock);
    assert.equal(first.released, true);

    const second = releaseSendLock(lock);
    assert.equal(second.released, true);
    assert.ok(second.reason.includes('already gone'));
  });
});

test('releaseSendLock: defensive no-op for null or never-acquired lock refs', () => {
  assert.equal(releaseSendLock(null).released, false);
  assert.equal(releaseSendLock({ acquired: false }).released, false);
});

// BRO-886: this is the property the fix in scripts/send-opening-night-broadcast.js
// leans on — release() and a later, unrelated acquire() for the SAME purpose after a
// clean release must not see any leftover state (no stale "still held" or "taken over"
// artifacts once the file is truly gone).
test('acquireSendLock: after a clean release, a fresh acquire for the same purpose succeeds with a new sessionId', () => {
  withFakeGh(() => {
    const first = acquireSendLock({ purpose: 'test-cycle', ttlMs: 5000 });
    assert.equal(first.acquired, true);
    assert.equal(releaseSendLock(first).released, true);

    const second = acquireSendLock({ purpose: 'test-cycle', ttlMs: 5000 });
    assert.equal(second.acquired, true, second.reason);
    assert.notEqual(second.sessionId, first.sessionId);
  });
});
