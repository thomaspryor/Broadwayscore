// The test-only shows sandbox (shows-sandbox-preload.cjs) must keep a script
// under test away from the real data/shows.json, whichever way it writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, 'shows-sandbox-preload.cjs');
// The guard is aimed at a decoy "real" shows.json (SHOWS_SANDBOX_GUARD_PATH),
// so even a broken guard cannot touch data/shows.json.
const decoyDir = mkdtempSync(join(tmpdir(), 'shows-sandbox-decoy-'));
const REAL = join(decoyDir, 'shows.json');
writeFileSync(REAL, '{"decoy":true}');
process.on('exit', () => rmSync(decoyDir, { recursive: true, force: true }));

function inSandbox(code) {
  const dir = mkdtempSync(join(tmpdir(), 'shows-sandbox-test-'));
  const file = join(dir, 'shows.json');
  writeFileSync(file, JSON.stringify({ _meta: {}, shows: [{ id: 'sandbox-only' }] }));
  try {
    const r = spawnSync(process.execPath, ['-r', PRELOAD, '-e', code], {
      cwd: join(here, '..', '..'),
      env: { ...process.env, SHOWS_SANDBOX_FILE: file, SHOWS_SANDBOX_GUARD_PATH: REAL, REAL },
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
    "fs.openSync(process.env.REAL, fs.constants.O_WRONLY | fs.constants.O_CREAT)",
    "fs.writeFileSync(Buffer.from(process.env.REAL), 'x')",
    "fs.writeFileSync(new URL('file://' + process.env.REAL), 'x')",
  ];
  const r = inSandbox(`const fs = require('fs');\n${cases.map(tryWrite).join('\n')}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), cases.map(() => 'REFUSED'), r.stdout);
  assert.equal(readFileSync(REAL, 'utf8'), '{"decoy":true}');
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
  const r = inSandbox(`const fs = require('fs'); console.log(fs.readFileSync(fs.openSync(process.env.REAL, 'r'), 'utf8'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '{"decoy":true}');
});

test('fs.promises.open for write is refused; guard options such as dryRun are kept', () => {
  const r = inSandbox(`
    const fs = require('fs');
    fs.promises.open(process.env.REAL, 'w').then(() => console.log('WROTE'), (e) => console.log(/sandbox/.test(e.message) ? 'REFUSED' : 'OTHER'))
      .then(() => {
        const { createShowsWriteGuard } = require('./scripts/lib/shows-write-guard');
        const g = createShowsWriteGuard(process.env.REAL, { dryRun: true });
        const d = g.loadShows(); d.shows.push({ id: 'added' }); g.saveShows(d);
        console.log(JSON.stringify(createShowsWriteGuard(process.env.REAL).loadShows().shows.map((s) => s.id)));
      });`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['REFUSED', '["sandbox-only"]']);
});
