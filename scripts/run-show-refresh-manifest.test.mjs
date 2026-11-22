// Tests for scripts/run-show-refresh-manifest.js and verify-show-refresh-manifest.js
// (BRO-8056 phase 1b). Real modules, real child processes, temp roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { run } = require('./run-show-refresh-manifest.js');
const { verify } = require('./verify-show-refresh-manifest.js');
const { buildManifest, MANIFEST_FILE } = require('./lib/show-refresh/manifest.js');

const quiet = { log() {}, warn() {} };

function tempRoot(t, builderSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'show-refresh-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  if (builderSource != null) fs.writeFileSync(path.join(root, 'builder.ts'), builderSource);
  return root;
}
const manifestAt = root => path.join(root, MANIFEST_FILE);
const writer = `import fs from 'fs'; const x: number = 1; fs.writeFileSync('${MANIFEST_FILE}', JSON.stringify({ x }));`;

test('a working builder leaves a fresh manifest', t => {
  const root = tempRoot(t, writer);
  fs.writeFileSync(manifestAt(root), 'stale');
  assert.deepEqual(run({ builder: 'builder.ts', root, log: quiet }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestAt(root), 'utf8')), { x: 1 });
});

test('a throwing builder leaves no manifest (stale one removed) and does not throw', t => {
  const root = tempRoot(t, `throw new Error('boom');`);
  fs.writeFileSync(manifestAt(root), 'stale');
  const r = run({ builder: 'builder.ts', root, log: quiet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exit 1/);
  assert.equal(fs.existsSync(manifestAt(root)), false);
});

test('a hung builder is killed at the time limit and leaves no manifest', t => {
  const root = tempRoot(t, `import fs from 'fs'; fs.writeFileSync('${MANIFEST_FILE}', 'partial'); setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  const r = run({ builder: 'builder.ts', root, log: quiet, env: { ...process.env, SHOW_REFRESH_MANIFEST_TIMEOUT_MS: '1500' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out|SIGKILL/);
  assert.ok(Date.now() - t0 < 15000);
  assert.equal(fs.existsSync(manifestAt(root)), false);
});

test('a builder that exits 0 without writing counts as a failure', t => {
  const root = tempRoot(t, `const y = 1;`);
  const r = run({ builder: 'builder.ts', root, log: quiet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /wrote no manifest/);
});

test('the CLI always exits 0, even for a failing builder', t => {
  const root = tempRoot(t, `throw new Error('boom');`);
  const { spawnSync } = require('node:child_process');
  const cli = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'run-show-refresh-manifest.js'), path.join(root, 'builder.ts')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
});

function realManifest(dataFiles, publicSha) {
  return buildManifest({
    manifestId: 'm', buildInstant: Date.UTC(2026, 10, 22), coreSha: null, publicSha,
    registryFile: { outlets: {} }, dataFiles, imageKeys: [], shows: [],
    sliceHashById: new Map(), heldById: new Map(),
  });
}

test('verifier keeps a manifest whose data is unchanged and removes one whose data moved', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":1}');
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest({ 'shows.json': '{"a":1}' }, null)));
  assert.deepEqual(verify({ root, log: quiet, env: {} }), { ok: true, problems: [] });
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":2}');
  const r = verify({ root, log: quiet, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /shows\.json changed during the build/);
  assert.equal(fs.existsSync(manifestAt(root)), false);
});

test('verifier removes a manifest built from another commit', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest({}, 'a'.repeat(40))));
  // temp root is not a git repo, so the verifier falls back to the CI sha
  const r = verify({ root, log: quiet, env: { GITHUB_SHA: 'b'.repeat(40) } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(';'), /publicSha/);
});
