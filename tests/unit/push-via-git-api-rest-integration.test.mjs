// Integration test for push-via-git-api.sh's opt-in REST ref-update branch
// (BRO-2233/BRO-2951 Phase 2). Exercises the bash<->node wiring end-to-end
// against a real local bare-repo fixture (same pattern as
// tests/unit/push-via-git-api.test.mjs) with a STUB REST module standing in
// for GitHub's API — no live network. Both plan-review rounds flagged the
// bash/subprocess boundary (JSON request shape, blob-cache-once behavior,
// mode preservation, outcome mapping) as the one thing the pure-function
// unit tests in scripts/lib/push-via-git-api-rest.test.mjs cannot see; this
// file closes that gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'push-via-git-api.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function setupOriginWithSeed(tmp, seedFiles) {
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  sh(`git init -q --bare "${originDir}"`, tmp);
  sh(`git init -q "${seedDir}"`, tmp);
  sh('git config user.email t@t.t', seedDir);
  sh('git config user.name t', seedDir);
  for (const [rel, content] of Object.entries(seedFiles)) {
    const full = path.join(seedDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  sh('git add -A', seedDir);
  sh('git commit -q -m base', seedDir);
  sh('git branch -M main', seedDir);
  sh(`git push -q "${originDir}" main`, seedDir);
  return originDir;
}

function cloneRepo(originDir, dest) {
  sh(`git clone -q --branch main "${originDir}" "${dest}"`, path.dirname(dest));
  sh('git config user.email t@t.t', dest);
  sh('git config user.name t', dest);
}

/** Writes a stub REST module: logs every invocation, serves canned
 * responses from a queue file (one JSON value consumed per attempt-push
 * call; create-blob always succeeds and returns a deterministic sha). */
function writeStubModule(dir) {
  const stubPath = path.join(dir, 'stub-rest-module.js');
  fs.writeFileSync(stubPath, `
const fs = require('fs');
const crypto = require('crypto');
const CALL_LOG = process.env.CALL_LOG;
const RESPONSE_QUEUE = process.env.RESPONSE_QUEUE;

function appendLog(entry) {
  fs.appendFileSync(CALL_LOG, JSON.stringify(entry) + '\\n');
}

const [, , mode, ...rest] = process.argv;
if (mode === 'create-blob') {
  const [contentFile, repoSlug] = rest;
  const content = fs.readFileSync(contentFile, 'utf8');
  const sha = crypto.createHash('sha1').update(content).digest('hex');
  appendLog({ mode, contentFile, repoSlug, content });
  process.stdout.write(JSON.stringify({ ok: true, sha }) + '\\n');
} else if (mode === 'attempt-push') {
  const [requestFile] = rest;
  const req = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  appendLog({ mode, req });
  const queue = JSON.parse(fs.readFileSync(RESPONSE_QUEUE, 'utf8'));
  const next = queue.shift();
  fs.writeFileSync(RESPONSE_QUEUE, JSON.stringify(queue));
  process.stdout.write(JSON.stringify(next) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ outcome: 'fatal', reason: 'unknown stub mode' }) + '\\n');
}
`);
  return stubPath;
}

function runScript(args, cwd, extraEnv) {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-stub-'));
  const stubPath = writeStubModule(stubDir);
  const callLog = path.join(stubDir, 'calls.jsonl');
  fs.writeFileSync(callLog, '');
  const responseQueue = path.join(stubDir, 'queue.json');
  fs.writeFileSync(responseQueue, JSON.stringify(extraEnv.responses || []));

  const env = {
    ...process.env,
    ...GIT_ENV,
    PUSH_API_REST_REF_UPDATE: '1',
    PUSH_API_REST_MODULE_PATH: stubPath,
    PUSH_API_REST_REPO_SLUG: 'testowner/testrepo',
    GH_TOKEN: 'fake-token-for-test',
    CALL_LOG: callLog,
    RESPONSE_QUEUE: responseQueue,
    ...(extraEnv.envOverrides || {}),
  };
  for (const key of extraEnv.deleteEnv || []) {
    delete env[key];
  }
  let result;
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { cwd, env, stdio: 'pipe' }).toString().trim();
    result = { code: 0, stdout };
  } catch (err) {
    result = { code: err.status, stdout: (err.stdout || '').toString().trim(), stderr: (err.stderr || '').toString() };
  }
  const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...result, calls };
}

test('REST path: single-file push succeeds, sends a correctly-shaped request, and mode/branch are preserved', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.mkdirSync(path.join(runnerDir, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'data/audit/health-digest-snapshot.json'), '{"ok":true}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "data: update snapshot"', runnerDir);

    const { code, stdout, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      responses: [{ outcome: 'success', sha: 'FAKE_LANDED_SHA' }],
    });

    assert.equal(code, 0);
    assert.equal(stdout, 'FAKE_LANDED_SHA');

    const blobCalls = calls.filter((c) => c.mode === 'create-blob');
    const pushCalls = calls.filter((c) => c.mode === 'attempt-push');
    assert.equal(blobCalls.length, 1, 'exactly one blob uploaded for the one changed file');
    assert.equal(pushCalls.length, 1);

    const req = pushCalls[0].req;
    assert.equal(req.repoSlug, 'testowner/testrepo');
    assert.equal(req.branch, 'main');
    assert.equal(req.message, 'data: update snapshot');
    assert.equal(req.entries.length, 1);
    assert.equal(req.entries[0].path, 'data/audit/health-digest-snapshot.json');
    assert.equal(req.entries[0].mode, '100644');
    assert.ok(req.expectedTreeSha, 'a locally-built expectedTreeSha is sent for server-side verification');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: a race response retries WITHOUT re-uploading the already-cached non-merge blob', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.mkdirSync(path.join(runnerDir, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'data/audit/ledger.json'), '{"n":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "data: update ledger"', runnerDir);

    const { code, stdout, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      responses: [
        { outcome: 'race', reason: 'remote moved' },
        { outcome: 'success', sha: 'FAKE_LANDED_SHA_2' },
      ],
    });

    assert.equal(code, 0);
    assert.equal(stdout, 'FAKE_LANDED_SHA_2');
    const blobCalls = calls.filter((c) => c.mode === 'create-blob');
    const pushCalls = calls.filter((c) => c.mode === 'attempt-push');
    assert.equal(blobCalls.length, 1, 'blob upload happens ONCE, not once per retry attempt (P0-1)');
    assert.equal(pushCalls.length, 2, 'attempt-push is called once per retry, unlike blob upload');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: executable mode (100755) is preserved in the tree entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    const scriptPath = path.join(runnerDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho hi\n');
    fs.chmodSync(scriptPath, 0o755);
    sh('git add -A', runnerDir);
    sh('git commit -q -m "feat: add executable script"', runnerDir);

    const { code, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      responses: [{ outcome: 'success', sha: 'FAKE_LANDED_SHA_3' }],
    });

    assert.equal(code, 0);
    const req = calls.find((c) => c.mode === 'attempt-push').req;
    assert.equal(req.entries[0].mode, '100755');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: a delete is sent with sha:null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n', 'data/gone.json': '{"b":2}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.rmSync(path.join(runnerDir, 'data/gone.json'));
    sh('git add -A', runnerDir);
    sh('git commit -q -m "chore: remove stale file"', runnerDir);

    const { code, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      responses: [{ outcome: 'success', sha: 'FAKE_LANDED_SHA_4' }],
    });

    assert.equal(code, 0);
    const req = calls.find((c) => c.mode === 'attempt-push').req;
    assert.equal(req.entries.length, 1);
    assert.equal(req.entries[0].path, 'data/gone.json');
    assert.equal(req.entries[0].sha, null);
    const blobCalls = calls.filter((c) => c.mode === 'create-blob');
    assert.equal(blobCalls.length, 0, 'a pure delete never uploads a blob');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: a fatal outcome exits non-zero without exhausting all retries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.mkdirSync(path.join(runnerDir, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'data/audit/ledger.json'), '{"n":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "data: update ledger"', runnerDir);

    const { code, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      responses: [{ outcome: 'fatal', reason: 'protected branch rejection' }],
    });

    assert.equal(code, 1);
    const pushCalls = calls.filter((c) => c.mode === 'attempt-push');
    assert.equal(pushCalls.length, 1, 'a fatal outcome must not burn the remaining retry budget');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: an apiFallbackMerge path uploads a FRESH blob for the actually-merged content, unlike a cached non-merge blob', () => {
  // data/audit/alert-router-attempts.jsonl is registered apiFallbackMerge
  // (core-data-merge-registry.js) — a genuinely multi-writer file. Unlike
  // P0-1's non-merge caching, this path's content is recomputed against
  // whatever the remote tip is on EVERY attempt, so it must never be
  // served from REST_BLOB_CACHE.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-merge-'));
  try {
    const originDir = setupOriginWithSeed(tmp, {
      'data/audit/alert-router-attempts.jsonl':
        '{"ts":"2026-09-01T00:00:00.000Z","conditionKey":"base","title":"base","ok":true,"error":null}\n',
    });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.appendFileSync(
      path.join(runnerDir, 'data/audit/alert-router-attempts.jsonl'),
      '{"ts":"2026-09-01T00:00:02.000Z","conditionKey":"our-writer","title":"ours","ok":true,"error":null}\n',
    );
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our alert"', runnerDir);

    const { code, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      responses: [{ outcome: 'success', sha: 'FAKE_LANDED_SHA_MERGE' }],
    });

    assert.equal(code, 0);
    const blobCalls = calls.filter((c) => c.mode === 'create-blob');
    assert.equal(blobCalls.length, 1, 'the merge path uploads exactly one fresh blob this attempt');
    const decoded = Buffer.from(blobCalls[0].content, 'base64').toString('utf8');
    assert.match(decoded, /our-writer/, 'the uploaded blob is the MERGED content, not the raw local diff');
    assert.match(decoded, /base/, 'the merge result still includes the base line');

    const req = calls.find((c) => c.mode === 'attempt-push').req;
    assert.equal(req.entries.length, 1);
    assert.equal(req.entries[0].path, 'data/audit/alert-router-attempts.jsonl');
    assert.ok(req.entries[0].sha, 'merge path entry carries the freshly-uploaded blob sha');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: a throttled outcome backs off and retries (does not burn the whole budget like a fatal)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.mkdirSync(path.join(runnerDir, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'data/audit/ledger.json'), '{"n":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "data: update ledger"', runnerDir);

    const { code, stdout, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      // retryAfter=1 keeps the test fast — real values get clamped to
      // [1,60] by push-via-git-api.sh, so 1 exercises the real clamp path.
      responses: [
        { outcome: 'throttled', reason: 'secondary rate limit', retryAfter: 1 },
        { outcome: 'success', sha: 'FAKE_LANDED_SHA_THROTTLE' },
      ],
    });

    assert.equal(code, 0);
    assert.equal(stdout, 'FAKE_LANDED_SHA_THROTTLE');
    const pushCalls = calls.filter((c) => c.mode === 'attempt-push');
    assert.equal(pushCalls.length, 2, 'a throttled outcome retries rather than aborting');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REST path: opted in but no token/slug resolves falls back to the git-push path and still succeeds', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-via-git-api-rest-'));
  try {
    const originDir = setupOriginWithSeed(tmp, { 'data/base.json': '{"a":1}\n' });
    const runnerDir = path.join(tmp, 'runner');
    cloneRepo(originDir, runnerDir);
    const baseSha = sh('git rev-parse HEAD', runnerDir).trim();

    fs.mkdirSync(path.join(runnerDir, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'data/audit/ledger.json'), '{"n":1}\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "data: update ledger"', runnerDir);

    // PUSH_API_REST_REF_UPDATE=1 is still set (via runScript's default env),
    // but with no PUSH_API_REST_REPO_SLUG override and no real github.com
    // remote, _github_repo_slug() fails — and no GH_TOKEN/GITHUB_TOKEN, so
    // _resolve_github_token() also fails. USE_REST_REF_UPDATE must resolve
    // to false and the script must fall through to the ordinary git-push
    // path, landing a REAL commit sha (not the stub's fake one).
    const { code, stdout, calls } = runScript(['main', baseSha, '6'], runnerDir, {
      deleteEnv: ['PUSH_API_REST_REPO_SLUG', 'GH_TOKEN', 'GITHUB_TOKEN'],
    });

    assert.equal(code, 0);
    assert.match(stdout, /^[0-9a-f]{40}$/, 'lands via the real git-push path, not the stub');
    assert.equal(calls.length, 0, 'the REST module is never invoked when the opt-in preconditions are not met');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
