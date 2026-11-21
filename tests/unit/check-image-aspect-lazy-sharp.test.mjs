// The pre-commit image check must not load sharp unless an image is staged.
// Root cause it guards: in a cloud container whose sharp native binary is
// broken, `require('sharp')` dies with SIGBUS (uncatchable), and the old
// top-level require in check-image-aspect.js failed EVERY commit, data-only
// ones included (2026-11-21, BRO-7914 session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-image-aspect.js');

test('check-image-aspect --staged with no staged images never requires sharp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sharp-'));
  // Preload: any require('sharp') kills the process the way a broken binary does.
  const preload = path.join(dir, 'sharp-bomb.cjs');
  fs.writeFileSync(preload, `
const Module = require('module');
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'sharp') process.kill(process.pid, 'SIGBUS');
  return orig.call(this, req, ...rest);
};
`);
  try {
    // An index equal to HEAD: nothing staged, whatever the working tree holds.
    const index = path.join(dir, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const rt = spawnSync('git', ['read-tree', 'HEAD'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(rt.status, 0, rt.stderr);

    const r = spawnSync(process.execPath, ['--require', preload, SCRIPT, '--staged'], {
      cwd: ROOT, env, encoding: 'utf8',
    });
    assert.equal(r.signal, null, `script loaded sharp at startup (killed by ${r.signal})`);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
