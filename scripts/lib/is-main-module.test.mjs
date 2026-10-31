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
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
    assert.equal(r.status, 0, `${lib} exited ${r.status} (stderr: ${r.stderr})`);
    const answer = JSON.parse(r.stdout.trim().split('\n').pop());
    // A wrong answer fails the hook open as surely as no answer.
    if (lib === 'transcript-scan.mjs') assert.equal(answer.isPush, true, JSON.stringify(answer));
    else assert.equal(typeof answer.allowed, 'boolean', JSON.stringify(answer));
  });
}

// Any spelling of the check (`file://${...}`, 'file://' + ..., pathToFileURL(
// argv[1]).href, fileURLToPath(...) === resolve(argv[1])) breaks the same way
// unless it realpaths argv[1] (BRO-5261 retro-review: the guard used to match
// one exact byte string and missed two live variants).
function bareMainChecks(cwd) {
  const r = spawnSync('git', ['grep', '-n', '-E', 'import\\.meta\\.url.*process\\.argv\\[1\\]|process\\.argv\\[1\\].*import\\.meta\\.url',
    '--', 'scripts', '.claude', 'src', 'tools', 'supabase'], { cwd, encoding: 'utf8' });
  if (r.status === 1) return []; // git grep: no match at all
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((l) => l && !/realpath/i.test(l)
    && !/^scripts\/lib\/is-main-module(\.test)?\.mjs:/.test(l));
}

test('no script compares import.meta.url with process.argv[1] without realpath', () => {
  const hits = bareMainChecks(ROOT);
  assert.deepEqual(hits, [], `use isMainModule(import.meta.url) from scripts/lib/is-main-module.mjs instead:\n${hits.join('\n')}`);
});

test('the main-module guard catches the variants it exists for (and is clean on none)', (t) => {
  const dir = tmp(t, 'guard-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'scripts'));
  assert.deepEqual(bareMainChecks(dir), []);
  fs.writeFileSync(path.join(dir, 'scripts', 'a.mjs'), "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();\n");
  fs.writeFileSync(path.join(dir, 'scripts', 'b.mjs'), "if (import.meta.url === 'file://' + process.argv[1]) run();\n");
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.mjs'), "if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) run();\n");
  execFileSync('git', ['add', '.'], { cwd: dir });
  assert.deepEqual(bareMainChecks(dir).map((l) => l.split(':')[0]), ['scripts/a.mjs', 'scripts/b.mjs']);
});
