// BRO-7171 Stage 3: whole-run lock between the nightly gap-recovery job and
// manual recover-*-browser.js runs. Real processes, real lock file.
// Run: node --test scripts/lib/recovery-run-lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recovery-run-lock.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lock-'));
const env = { ...process.env, RECOVERY_RUN_LOCK_PATH: path.join(dir, 'run.lock') };

const tryAcquire = (label) => spawnSync(process.execPath, ['-e', `
  try { require(${JSON.stringify(LIB)}).acquireRunLock(${JSON.stringify(label)}); console.log('ACQUIRED'); }
  catch (e) { console.log(e.code + ' ' + e.message); }`], { env, encoding: 'utf8' }).stdout.trim();

test('a live holder makes a second run refuse with the holder named; release frees it', async () => {
  const holder = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(LIB)}).acquireRunLock('nightly');
    console.log('HELD'); setTimeout(() => {}, 20000);`], { env });
  await new Promise((res) => holder.stdout.once('data', res));
  const out = tryAcquire('recover-thestage-browser');
  assert.match(out, /^ERUNLOCKBUSY .*nightly/);
  holder.kill('SIGTERM');
  await new Promise((res) => holder.once('exit', res));
  // SIGTERM skips 'exit' handlers: the file is left behind, but its holder is dead -> stale.
  assert.equal(tryAcquire('recover-thestage-browser'), 'ACQUIRED');
});

test('normal exit releases the lock file', () => {
  assert.equal(tryAcquire('a'), 'ACQUIRED');
  assert.equal(fs.existsSync(env.RECOVERY_RUN_LOCK_PATH), false);
});

test('class guard: every recover-*-browser.js and the driver/nightly take the run lock', () => {
  const scripts = path.join(path.dirname(LIB), '..');
  const browser = fs.readdirSync(scripts).filter((f) => /^recover-.*-browser\.js$/.test(f));
  assert.ok(browser.length >= 6, 'found the browser recovery scripts');
  for (const f of browser) {
    assert.match(fs.readFileSync(path.join(scripts, f), 'utf8'), /acquireRecoveryRunLock\(/, `${f} must take the recovery run lock before opening Chrome`);
  }
  assert.match(fs.readFileSync(path.join(scripts, 'gap-recovery-driver.js'), 'utf8'), /takeRunLock\(/);
  assert.match(fs.readFileSync(path.join(scripts, 'gap-recovery-nightly.js'), 'utf8'), /acquireRunLock\('gap-recovery-nightly'\)/);
});

test('re-entrant in-process', () => {
  const out = spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(LIB)}); L.acquireRunLock('x'); L.acquireRunLock('x'); console.log('OK');`], { env, encoding: 'utf8' }).stdout.trim();
  assert.equal(out, 'OK');
});
