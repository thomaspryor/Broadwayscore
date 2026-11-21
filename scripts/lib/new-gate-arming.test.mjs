// BRO-7949: new hard error() inside a blocking validator must carry advisory/baseline/proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { findUnprovenNewValidatorErrors } = require('./new-gate-arming.js');

const V = 'scripts/validate-data.js';
const diff = (lines) => `--- a/${V}\n+++ b/${V}\n@@ -10,3 +10,4 @@\n context\n${lines.join('\n')}\n context\n`;
const run = (lines, extra = {}) => findUnprovenNewValidatorErrors({
  files: [{ path: V, diff: diff(lines), headText: '', ...extra.file }], changedFiles: extra.changed || [V], contextTexts: extra.ctx,
}).violations;

test('added error() without annotation is a violation', () => {
  assert.equal(run(['+    error(`Show ${id} has no openingDate`);', '+    issues++;']).length, 1);
});
test('// gate-arm-ok: in the hunk passes', () => {
  assert.deepEqual(run(['+    // gate-arm-ok: 0 hits on live tree 2026-11-21', '+    error(`x`);']), []);
});
test('warn() is fine', () => assert.deepEqual(run(['+    warn(`x`);']), []));
test('removed error() is fine', () => assert.deepEqual(run(['-    error(`x`);', '+    warn(`x`);']), []));
test('rewording an existing error() (paired removal) is fine', () => {
  assert.deepEqual(run(['-    error(`old text`);', '+    error(`new text`);']), []);
});
test('wrappers reviewFileError/reviewRowError count; console.error, comments, strings, definitions do not', () => {
  assert.equal(run(['+    reviewFileError(`x`, f, r);']).length, 1);
  assert.equal(run(['+    reviewRowError(`x`, r);']).length, 1);
  assert.deepEqual(run(['+    console.error(`x`);', '+    // promote to error() later', '+    warn("advisory, not error() yet");', '+function error(msg) {']), []);
});
test('changed baseline file the validator references exempts; unrelated baseline does not', () => {
  const l = ['+    error(`x`);'];
  assert.deepEqual(run(l, { changed: [V, 'data/audit/missing-opening-date-baseline.json'], ctx: ["require('data/audit/missing-opening-date-baseline.json')"] }), []);
  assert.equal(run(l, { changed: [V, 'data/audit/other-baseline.json'], ctx: ['nothing'] }).length, 1);
});
test('non-validator files are ignored', () => {
  const r = findUnprovenNewValidatorErrors({ files: [{ path: 'scripts/other.js', diff: diff(['+error(`x`);']) }], changedFiles: [] });
  assert.deepEqual(r.violations, []);
});

test('CLI e2e: added error() fails, advisory env downgrades, warn() passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-arm-val-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    for (const f of ['scripts/audit-new-gate-arming.js', 'scripts/lib/new-gate-arming.js', 'scripts/lib/cli-help.js']) copyFileSync(path.join(REPO, f), path.join(dir, f));
    writeFileSync(path.join(dir, '.github/workflows/test.yml'), 'name: t\njobs:\n  a:\n    steps:\n      - name: x\n        run: echo\n');
    writeFileSync(path.join(dir, V), 'function error(m){}\nfunction warn(m){}\nwarn("a");\n');
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '.'); g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD').trim();
    const cli = (env = {}) => spawnSync('node', ['scripts/audit-new-gate-arming.js', `--base=${base}`], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    writeFileSync(path.join(dir, V), 'function error(m){}\nfunction warn(m){}\nwarn("a");\nerror(`bad`);\n');
    g('commit', '-qam', 'add error');
    const bad = cli(); assert.equal(bad.status, 1, bad.stdout + bad.stderr); assert.match(bad.stdout, /BRO-7949/);
    assert.equal(cli({ GATE_ARM_VALIDATOR_ADVISORY: '1' }).status, 0);
    writeFileSync(path.join(dir, V), 'function error(m){}\nfunction warn(m){}\nwarn("a");\nwarn(`bad`);\n');
    g('commit', '-qam', 'warn');
    assert.equal(cli().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unrelated removed error() elsewhere does not cancel a new one (separate hunks)', () => {
  const d = `--- a/${V}\n+++ b/${V}\n@@ -1,3 +1,3 @@\n c\n-    error(\`old thing\`);\n c\n@@ -50,3 +50,4 @@\n c\n+    error(\`brand new\`);\n c\n`;
  assert.equal(findUnprovenNewValidatorErrors({ files: [{ path: V, diff: d }], changedFiles: [V] }).violations.length, 1);
});
test('moved error() (identical text, different hunk) is fine', () => {
  const d = `--- a/${V}\n+++ b/${V}\n@@ -1,3 +1,3 @@\n c\n-    error(\`same\`);\n c\n@@ -50,3 +50,4 @@\n c\n+    error(\`same\`);\n c\n`;
  assert.deepEqual(findUnprovenNewValidatorErrors({ files: [{ path: V, diff: d }], changedFiles: [V] }).violations, []);
});
test('marker in unchanged context does not exempt a later added error()', () => {
  const d = `--- a/${V}\n+++ b/${V}\n@@ -1,4 +1,5 @@\n // gate-arm-ok: old proof\n c\n+    error(\`new\`);\n c\n`;
  assert.equal(findUnprovenNewValidatorErrors({ files: [{ path: V, diff: d }], changedFiles: [V] }).violations.length, 1);
});
test('baseline named only in the validator head text (not the diff/helpers) does not exempt', () => {
  assert.equal(run(['+    error(`x`);'], { changed: [V, 'data/audit/x-baseline.json'], file: { headText: "require('x-baseline.json')" } }).length, 1);
});

test('two calls on one line: pairing one leaves the other flagged', () => {
  assert.equal(run(['-    error(`old`);', '+    error(`old`); error(`new`);']).length, 1);
});
test('exitWithError helper counts', () => assert.equal(run(['+    exitWithError(`x`);']).length, 1));
test('url string before a call does not hide it', () => assert.equal(run(['+    if (u === "https://x.com") error(`x`);']).length, 1));
test('marker inside a string literal is not proof', () => assert.equal(run(['+    const m = "// gate-arm-ok: fake";', '+    error(`x`);']).length, 1));
test('warn() promoted to error() needs proof: flagged bare, ok with a gate-arm-ok marker (BRO-7929 re-add)', () => {
  assert.equal(run(['-    warn(`Show x has no date`);', '+    error(`Show x has no date`);']).length, 1);
  assert.deepEqual(run(['-    warn(`Show x has no date`);', '+    // gate-arm-ok: one green main run 2026-11-21 (BRO-7929)', '+    error(`Show x has no date`);']), []);
});
