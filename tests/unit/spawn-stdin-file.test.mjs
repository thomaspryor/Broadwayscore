// tests/helpers/spawn-stdin-file.mjs: a hook that exits without reading stdin
// must not fail the test with EPIPE (main test.yml run 38367466885 went red on
// pre-push-visual-gate-fixture's self-skip case this way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile, execFileSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Larger than a pipe buffer, so the pipe write reliably hits a closed pipe.
const BIG = 'x'.repeat(4 * 1024 * 1024);

test('control: a pipe write to a child that exits unread fails with EPIPE', () => {
  const r = spawnSync('bash', ['-c', 'exit 0'], { input: BIG, encoding: 'utf8' });
  assert.equal(r.error?.code, 'EPIPE');
});

test('stdin from a file: child that exits unread returns its status, no error', () => {
  const r = spawnSyncStdinFile('bash', ['-c', 'exit 3'], { input: BIG, encoding: 'utf8' });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 3);
});

test('a caller stdio choice for stdout/stderr is kept', () => {
  const r = spawnSyncStdinFile('bash', ['-c', 'cat; echo err >&2'], { input: 'in', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(r.stdout, 'in');
  assert.equal(r.stderr, null);
});

test('execFileSync variant returns stdout and throws on non-zero exit', () => {
  assert.equal(execFileSyncStdinFile('bash', ['-c', 'cat'], { input: 'abc', encoding: 'utf8' }), 'abc');
  assert.throws(() => execFileSyncStdinFile('bash', ['-c', 'exit 4'], { input: BIG, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }), (e) => e.status === 4);
});

test('stdin from a file: child that reads gets the exact payload', () => {
  const r = spawnSyncStdinFile('bash', ['-c', 'cat'], { input: '{"a":1}\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"a":1}\n');
});

const SHELL_CALL = /(spawnSync|execFileSync)\(\s*['"](?:\/bin\/)?(?:bash|sh)['"]/;

// Guard: hook tests must not pipe a payload with spawnSync('bash', [...], { input }).
// Hooks commonly exit (self-skip, kill switch) before reading stdin.
test('no hook test pipes stdin into bash with plain spawnSync', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(p); continue; }
      if (!/\.test\.(mjs|js|ts)$/.test(e.name) || p === fileURLToPath(import.meta.url)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!/hooks/.test(src)) continue;
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // cp.spawnSync / child_process.execFileSync count too; so do sh and /bin/bash.
        if (!/(^|[^\w])(spawnSync|execFileSync)\($/.test(line.trimEnd()) && !SHELL_CALL.test(line)) return;
        // Call may wrap; options may sit a few lines below.
        const call = lines.slice(i, i + 8).join('\n');
        if (!SHELL_CALL.test(call)) return;
        if (/\binput\b\s*[:,}]/.test(call)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
      });
    }
  };
  // tests/ and all of scripts/: CI also runs scripts/*.test.mjs and
  // scripts/lib/*.test.mjs (scripts/lib/unit-test-collection.js), which the
  // first version of this scan never looked at (BRO-5261 retro-review).
  walk(path.join(ROOT, 'tests'));
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, [], 'use spawnSyncStdinFile from tests/helpers/spawn-stdin-file.mjs');
});

test('helper matches spawnSync on input: null, non-utf8 encoding and extra fds (BRO-5261)', () => {
  assert.equal(spawnSyncStdinFile('bash', ['-c', 'cat'], { input: null, encoding: 'utf8' }).status, 0);
  const hex = spawnSyncStdinFile('bash', ['-c', 'od -An -tx1'], { input: '\u00e9', encoding: 'latin1' }).stdout.trim();
  assert.equal(hex, 'e9');
  const r = spawnSyncStdinFile('bash', ['-c', 'cat >/dev/null; echo hi >&3'], { input: 'x', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  assert.equal(r.output[3], 'hi\n');
});
