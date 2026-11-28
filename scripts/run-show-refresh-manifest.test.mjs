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
const { buildManifest, isUsableManifest, MANIFEST_FILE, SLICE_REQUIRED_FILES, SLICE_OPTIONAL_FILES } = require('./lib/show-refresh/manifest.js');

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

// Every required input present on disk (content = its name), every optional one absent.
function writeInputs(root) {
  const files = {};
  for (const name of SLICE_REQUIRED_FILES) {
    if (name === 'shows.json') continue;
    files[name] = `{"f":"${name}"}`;
    fs.writeFileSync(path.join(root, 'data', name), files[name]);
  }
  return files;
}

function realManifest(dataFiles, publicSha, absentFiles = SLICE_OPTIONAL_FILES) {
  return buildManifest({
    manifestId: 'm', buildInstant: Date.UTC(2026, 10, 22), coreSha: null, publicSha,
    registryFile: { outlets: {} }, dataFiles, absentFiles, imageKeys: [], shows: [{ id: 's1', slug: 'show-one' }],
    sliceHashById: new Map([['s1', 'abc']]), heldById: new Map([['s1', false]]),
  });
}

test('verifier keeps a manifest whose data is unchanged and marks invalid (never deletes) one whose data moved', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":1}');
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest({ ...writeInputs(root), 'shows.json': '{"a":1}' }, null)));
  assert.deepEqual(verify({ root, log: quiet, env: {} }), { ok: true, problems: [] });
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":2}');
  const r = verify({ root, log: quiet, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /shows\.json changed during the build/);
  // Never deleted: Next already traced the file into functions.
  const after = JSON.parse(fs.readFileSync(manifestAt(root), 'utf8'));
  assert.equal(after.invalid, true);
  assert.equal(isUsableManifest(after), false);
});

test('verifier marks invalid a manifest built from another commit', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest({}, 'a'.repeat(40))));
  // temp root is not a git repo, so the verifier falls back to the CI sha
  const r = verify({ root, log: quiet, env: { GITHUB_SHA: 'b'.repeat(40) } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(';'), /publicSha/);
});

test('verifier that throws marks the manifest invalid and does not throw', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest({ 'shows.json': '{"a":1}' }, null)));
  // a directory where a data file should be makes readFileSync throw
  fs.mkdirSync(path.join(root, 'data', 'shows.json'));
  const r = verify({ root, log: quiet, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /verifier failed/);
  assert.equal(JSON.parse(fs.readFileSync(manifestAt(root), 'utf8')).invalid, true);
});

test('verifier checks the manifest against the shared input list, not its own (a builder that stopped hashing a file cannot vouch for itself)', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":1}');
  const files = { ...writeInputs(root), 'shows.json': '{"a":1}' };
  delete files['curated-historical-shows.json'];
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest(files, null, SLICE_OPTIONAL_FILES.slice(1))));
  const r = verify({ root, log: quiet, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(';'), /required input curated-historical-shows\.json not hashed/);
  assert.match(r.problems.join(';'), new RegExp(`optional input ${SLICE_OPTIONAL_FILES[0].replace('.', '\\.')} neither hashed nor recorded absent`));
  assert.equal(JSON.parse(fs.readFileSync(manifestAt(root), 'utf8')).invalid, true);
});

test('when the invalid marker cannot be written the manifest is deleted, and the log says so', t => {
  const root = tempRoot(t, null);
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":1}');
  fs.writeFileSync(manifestAt(root), JSON.stringify(realManifest({ ...writeInputs(root), 'shows.json': '{"a":1}' }, null)));
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '{"a":2}');
  // a directory at the temp path makes the marker write fail
  fs.mkdirSync(`${manifestAt(root)}.${process.pid}.tmp`);
  const warnings = [];
  const r = verify({ root, log: { ...quiet, warn: (m) => warnings.push(m) }, env: {} });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(manifestAt(root)), false, 'a manifest that could not be marked invalid must not survive');
  assert.match(r.problems.join(';'), /invalid marker failed/);
  assert.match(warnings.join('\n'), /manifest deleted/);
  assert.doesNotMatch(warnings.join('\n'), /marked invalid/);
});
