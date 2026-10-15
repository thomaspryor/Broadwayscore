/**
 * BRO-5209 — headless jobs run without /usr/sbin on PATH, so a bare
 * spawn('lsof') ENOENTs and every liveness guard fails safe to "keep".
 * Callers must spawn LSOF from scripts/lib/system-bin.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveSystemBin, LSOF } = require('../../scripts/lib/system-bin.js');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('resolveSystemBin prefers sbin dirs, falls back to bare name', () => {
  assert.equal(resolveSystemBin('lsof', ['/a', '/b'], (p) => p === '/b/lsof'), '/b/lsof');
  assert.equal(resolveSystemBin('lsof', ['/a'], () => false), 'lsof');
});

test('LSOF runs with a PATH that lacks /usr/sbin', { skip: process.platform !== 'darwin' && !fs.existsSync(LSOF) }, () => {
  assert.ok(path.isAbsolute(LSOF), `LSOF resolved to ${LSOF}`);
  const out = execFileSync(process.execPath, ['-e', "const {execFileSync}=require('child_process');const {LSOF}=require(process.argv[1]);process.stdout.write(String(execFileSync(LSOF,['-v'],{stdio:['ignore','pipe','pipe']}).length>=0))", path.join(ROOT, 'scripts/lib/system-bin.js')], { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(out, 'true');
});

test('no script spawns bare "lsof" (use LSOF from scripts/lib/system-bin.js)', () => {
  const files = execFileSync('git', ['ls-files', 'scripts', '.claude/hooks'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(c?js|mjs)$/.test(f) && !/\.test\.|\/tests?\//.test(f));
  const bad = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/(execFileSync|execFile|spawnSync|spawn)\(\s*['"`]lsof['"`]/.test(s) || /exec(Sync)?\(\s*['"`]lsof\b/.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
