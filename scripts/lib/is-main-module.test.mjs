// BRO-2312 follow-up: the visual-gate libs' CLI must run when reached through
// a symlink or a path with a space, or the hooks calling them fail open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from './is-main-module.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.dirname(LIB_DIR);
const ROOT = path.dirname(SCRIPTS);

function tmp(t, prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('isMainModule: direct path, symlinked path, path with a space', (t) => {
  const dir = tmp(t, 'is main ');
  const real = path.join(dir, 'real dir', 'x.mjs');
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, '');
  const link = path.join(dir, 'link');
  fs.symlinkSync(path.dirname(real), link);
  const url = pathToFileURL(real).href;
  assert.equal(isMainModule(url, real), true);
  assert.equal(isMainModule(url, path.join(link, 'x.mjs')), true);
  assert.equal(isMainModule(url, path.join(dir, 'other.mjs')), false);
  assert.equal(isMainModule(url, undefined), false);
  assert.equal(isMainModule(url, path.join(dir, 'missing.mjs')), false);
});

for (const lib of ['transcript-scan.mjs', 'visual-qa-ledger.mjs']) {
  test(`${lib} CLI runs through a symlinked scripts/ and a path with a space`, (t) => {
    const dir = tmp(t, 'cli path ');
    const link = path.join(dir, 'with space', 'scripts');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(SCRIPTS, link);
    const args = lib === 'transcript-scan.mjs'
      ? ['--query=push-ingress', '--command=git push origin main']
      : ['--query=push-allowed', `--repo=${dir}`, '--current-content-hash=abc'];
    const r = spawnSync(process.execPath, [path.join(link, 'lib', lib), ...args], { encoding: 'utf8', cwd: dir });
    assert.notEqual(r.stdout.trim(), '', `${lib} printed nothing via ${link} (stderr: ${r.stderr}) — its CLI did not run`);
    assert.doesNotThrow(() => JSON.parse(r.stdout.trim().split('\n').pop()));
  });
}

test('no script uses the bare `file://${process.argv[1]}` main-module idiom', () => {
  const needle = 'import.meta.url === `file://${process.argv[1]}`';
  const out = execFileSync('git', ['grep', '-l', '-F', needle, '--', 'scripts', '.claude', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const hits = out.split('\n').filter((f) => f && !f.endsWith('is-main-module.mjs') && !f.endsWith('is-main-module.test.mjs'));
  assert.deepEqual(hits, [], `use isMainModule(import.meta.url) from scripts/lib/is-main-module.mjs instead in:\n${hits.join('\n')}`);
});
