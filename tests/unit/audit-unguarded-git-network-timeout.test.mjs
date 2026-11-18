// BRO-7458: the advisory audit flagging sync git fetch/pull/clone with a timeout outside runGit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { scanText, scanFiles } = require('../../scripts/lib/unguarded-git-network-scan.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('flags execFileSync/spawnSync git fetch|clone|pull with a timeout', () => {
  const src = [
    "execFileSync('git', ['fetch', ...depthArgs, 'origin', 'main'], { cwd: repo, timeout: 30000 });",
    "spawnSync('git', ['-C', REPO, 'clone', url, dir], { timeout: 1000 });",
    "execFileSync('git', ['pull', '--rebase'], {\n  cwd,\n  timeout: 5000,\n});",
    "execSync('git fetch origin main', { cwd, timeout: 30000 });",
  ].join('\n');
  assert.deepEqual(scanText(src).map((h) => h.line), [1, 2, 3, 7]);
});

test('ignores guarded calls, non-network git, no timeout, and waived lines', () => {
  const src = [
    "runGitOrThrow(['fetch', 'origin', 'main'], { timeout: 30000 });",
    "execFileSync('git', ['rev-parse', 'HEAD'], { timeout: 30000 });",
    "execFileSync('git', ['push', 'origin', 'x'], { timeout: 30000 });",
    "execFileSync('git', ['fetch', 'origin'], { cwd });",
    '// git-net-timeout-ok: fixture',
    "execFileSync('git', ['fetch', 'origin'], { timeout: 1 });",
    "execSync('git status', { timeout: 1 });",
  ].join('\n');
  assert.deepEqual(scanText(src), []);
});

test('scanFiles tags the file', () => {
  const hits = scanFiles([{ file: 'scripts/x.js', text: "execFileSync('git', ['fetch'], { timeout: 1 });" }]);
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`), ['scripts/x.js:1']);
});

test('the live tree is clean and the CLI is advisory (exit 0)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/audit-unguarded-git-network-timeout.js'), '--json'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});
