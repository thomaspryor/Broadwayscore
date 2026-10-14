// The test-only shows sandbox (shows-sandbox-preload.cjs) must keep a script
// under test away from the real data/shows.json, whichever way it writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, 'shows-sandbox-preload.cjs');
const REAL = join(here, '..', '..', 'data', 'shows.json');

function inSandbox(code) {
  const dir = mkdtempSync(join(tmpdir(), 'shows-sandbox-test-'));
  const file = join(dir, 'shows.json');
  writeFileSync(file, JSON.stringify({ _meta: {}, shows: [{ id: 'sandbox-only' }] }));
  try {
    const r = spawnSync(process.execPath, ['-r', PRELOAD, '-e', code], {
      cwd: join(here, '..', '..'),
      env: { ...process.env, SHOWS_SANDBOX_FILE: file, REAL },
      encoding: 'utf8',
      timeout: 30000,
    });
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tryWrite = (expr) => `try { ${expr}; console.log('WROTE'); } catch (e) { console.log(/sandbox: refusing/.test(e.message) ? 'REFUSED' : 'OTHER ' + e.message); }`;

test('every write shape aimed at the real shows.json (or a shows.json* sibling) is refused', () => {
  const cases = [
    "fs.writeFileSync(process.env.REAL, 'x')",
    "fs.writeFileSync(process.env.REAL + '.tmp.123', 'x')",
    "fs.appendFileSync(process.env.REAL, 'x')",
    "fs.renameSync('/nonexistent-src', process.env.REAL)",
    "fs.unlinkSync(process.env.REAL)",
    "fs.rmSync(process.env.REAL, { force: true })",
    "fs.openSync(process.env.REAL, 'w')",
    "fs.writeFileSync(Buffer.from(process.env.REAL), 'x')",
    "fs.writeFileSync(new URL('file://' + process.env.REAL), 'x')",
  ];
  const r = inSandbox(`const fs = require('fs');\n${cases.map(tryWrite).join('\n')}`);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), cases.map(() => 'REFUSED'), r.stdout);
  } finally {
    rmSync(`${REAL}.tmp.123`, { force: true });
  }
});

test('a script that builds its own guard from a literal data/shows.json path still gets the sandbox file', () => {
  const r = inSandbox(`
    const { createShowsWriteGuard } = require('./scripts/lib/shows-write-guard');
    const g = createShowsWriteGuard(process.env.REAL);
    console.log(JSON.stringify(g.loadShows().shows.map((s) => s.id)));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '["sandbox-only"]');
});

test('reads of the real file are not blocked (only writes are)', () => {
  const r = inSandbox(`const fs = require('fs'); try { fs.openSync(process.env.REAL, 'r'); } catch (e) { if (/sandbox/.test(e.message)) { console.log('BLOCKED'); process.exit(0); } } console.log('OK');`);
  assert.equal(r.stdout.trim(), 'OK');
  assert.equal(existsSync(`${REAL}.tmp.123`), false);
});
