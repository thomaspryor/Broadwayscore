// tests/helpers/spawn-stdin-file.mjs: a hook that exits without reading stdin
// must not fail the test with EPIPE (main test.yml run 38367466885 went red on
// pre-push-visual-gate-fixture's self-skip case this way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

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

test('stdin from a file: child that reads gets the exact payload', () => {
  const r = spawnSyncStdinFile('bash', ['-c', 'cat'], { input: '{"a":1}\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"a":1}\n');
});

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
        if (!/(^|[^\w])spawnSync\(\s*'bash'\s*,\s*\[(?!\s*'-c')/.test(line)) return;
        const opts = lines.slice(i, i + 4).join('\n');
        if (/\binput\b\s*[:,}]/.test(opts)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
      });
    }
  };
  walk(path.join(ROOT, 'tests'));
  walk(path.join(ROOT, 'scripts', 'tests'));
  assert.deepEqual(offenders, [], 'use spawnSyncStdinFile from tests/helpers/spawn-stdin-file.mjs');
});
