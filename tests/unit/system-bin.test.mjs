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
const { resolveSystemBin, SBIN_BINARIES } = require('../../scripts/lib/system-bin.js');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('resolveSystemBin prefers sbin dirs, falls back to bare name', () => {
  assert.equal(resolveSystemBin('lsof', ['/a', '/b'], (p) => p === '/b/lsof'), '/b/lsof');
  assert.equal(resolveSystemBin('lsof', ['/a'], () => false), 'lsof');
});

const PROBES = { LSOF: ['-v'], SYSCTL: ['-n', 'hw.ncpu'] };
const CHILD = "const {execFileSync}=require('child_process');const m=require(process.argv[1]);const [name,...args]=process.argv.slice(2);execFileSync(m[name],args,{stdio:'ignore'});process.stdout.write(m[name]);";

test('LSOF/SYSCTL run with a PATH that lacks /usr/sbin', { skip: process.platform !== 'darwin' && 'macOS-only sbin layout' }, () => {
  for (const [name, args] of Object.entries(PROBES)) {
    const out = execFileSync(process.execPath, ['-e', CHILD, path.join(ROOT, 'scripts/lib/system-bin.js'), name, ...args], { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.ok(path.isAbsolute(out), `${name} resolved to ${out}`);
  }
});

const BINS = SBIN_BINARIES.join('|');
const spawnRe = new RegExp(`\\b(execFileSync|execFile|spawnSync|spawn|execSync|exec)\\(\\s*['"\`](${BINS})(['"\`\\s])`);
// Strip // and /* */ comments so docs that mention the anti-pattern don't trip the guard.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('no script spawns a bare sbin binary name (use the constant from scripts/lib/system-bin.js)', () => {
  const files = execFileSync('git', ['ls-files', 'scripts', '.claude/hooks', 'tests'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(c?js|mjs)$/.test(f) && f !== 'tests/unit/system-bin.test.mjs');
  const bad = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const m = stripComments(fs.readFileSync(p, 'utf8')).match(spawnRe);
    if (m) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('guard regex catches the original call shapes', () => {
  assert.match(stripComments("const r = spawnSync('lsof', ['+D', dir]);"), spawnRe);
  assert.match(stripComments("execFileSync('sysctl', ['vm.swapusage'])"), spawnRe);
  assert.match(stripComments('execSync("lsof -a -d cwd")'), spawnRe);
  assert.doesNotMatch(stripComments("/**\n * so a bare spawn('lsof') fails\n */"), spawnRe);
  assert.doesNotMatch(stripComments("// spawn('lsof') is banned"), spawnRe);
  assert.doesNotMatch(stripComments("execFileSync(LSOF, ['-v'])"), spawnRe);
});
