// BRO-208: Opening Night Poller false failures. When a sibling pipeline collects
// the same review, our rebase integrates its version and the push-content-survival
// check used to declare REVERTED on every retry (deterministic 5x loop) although
// the push had landed. Requires the real classifier + CLI (no copied logic).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = join(ROOT, 'scripts', 'lib');
const { classifyFileSurvivalDeep } = require(join(LIB, 'push-content-survival.js'));
const CLI = join(LIB, 'push-content-survival.js');

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

const tmpDirs = [];
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

function repro() {
  const dir = mkdtempSync(join(tmpdir(), 'poller-supersede-'));
  tmpDirs.push(dir);
  const f = join(dir, 'review.json');
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  writeFileSync(f, '{"outlet":"thr"}\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base'); git(dir, 'branch', '-M', 'main');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  writeFileSync(f, '{"outlet":"thr","fullText":"POLLER"}\n');
  git(dir, 'commit', '-qam', 'poller');
  const before = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'pushed', base);
  writeFileSync(f, '{"outlet":"thr","fullText":"SIBLING","scored":true}\n');
  git(dir, 'commit', '-qam', 'rebased onto sibling version');
  const pushed = git(dir, 'rev-parse', 'HEAD').trim();
  return { dir, base, before, pushed };
}
const run = (dir, args) => {
  const r = spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

test('sibling-pipeline supersede is classified superseded, not reverted', () => {
  assert.equal(classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'C', pushedBlob: 'C',
    addedLines: ['"fullText":"POLLER"'], baseContent: 'x\n', finalContent: 'y\n',
  }), 'superseded');
});

test('real clobber after push (pushedBlob != finalBlob) stays reverted', () => {
  assert.equal(classifyFileSurvivalDeep({
    baseBlob: 'A', localBlob: 'B', finalBlob: 'C', pushedBlob: 'D',
    addedLines: ['"fullText":"POLLER"'], baseContent: 'x\n', finalContent: 'y\n',
  }), 'reverted');
});

test('CLI: supersede with pushed-sha passes (no deterministic retry failure); without it fails', () => {
  const { dir, base, before, pushed } = repro();
  const common = [`--before-sha=${before}`, `--base-sha=${base}`, `--check-ref=${pushed}`];
  const ok = run(dir, [...common, `--pushed-sha=${pushed}`]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /SUPERSEDED/);
  assert.equal(run(dir, common).code, 1);
});

test('push-with-retry.sh passes the pushed sha to the survival check on every call site', () => {
  const sh = readFileSync(join(LIB, 'push-with-retry.sh'), 'utf8');
  assert.match(sh, /--pushed-sha="\$pushed_sha"/);
  assert.match(sh, /pushed_sha="\$\{1:-\}"/);
  assert.match(sh, /verify_content_survived "\$API_NEW_SHA"/);
});

test('poller commit step goes through push-with-retry with 20 retries', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8');
  assert.match(wf, /push-with-retry\.sh 20 main/);
});
