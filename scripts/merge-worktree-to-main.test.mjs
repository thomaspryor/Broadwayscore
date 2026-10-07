// BRO-2904: the landing script's legacy direct path must (a) exit non-zero when it
// cannot check out main and (b) never abandon its own "wt-integ-<pid>" stash, on a
// failed checkout, a die() from a path with no explicit restore, or a kill signal.
//
// Runs the REAL script (LAND_LEGACY_DIRECT=1, no origin/main re-exec) against a
// throwaway repo + bare origin. Run: node --test scripts/merge-worktree-to-main.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'merge-worktree-to-main.sh');
const ENV = {
  ...process.env,
  LAND_LEGACY_DIRECT: '1',
  MERGE_SCRIPT_NO_REEXEC: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// Bare origin + clone on main with a pushed feature branch. `auditStub` is the
// body of scripts/lib/run-push-audits.sh committed on main (the script runs it
// from the shared checkout before pushing).
function fixture(auditStub) {
  const root = mkdtempSync(join(tmpdir(), 'bro2904-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  spawnSync('git', ['init', '-q', '--bare', origin]);
  spawnSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'branch', '-M', 'main');
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  if (auditStub) {
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repo, 'scripts/lib/run-push-audits.sh'), auditStub);
  }
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature-branch');
  writeFileSync(join(repo, 'feature.txt'), 'feature\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'feature');
  git(repo, 'push', '-q', 'origin', 'feature-branch');
  git(repo, 'checkout', '-q', 'main');
  return { root, repo };
}

test('checkout of main fails after a successful stash: exits non-zero, stash restored', () => {
  const { root, repo } = fixture();
  try {
    // `other` untracks tracked.txt, so checking out main would overwrite the
    // untracked file left in the tree: checkout refuses.
    git(repo, 'checkout', '-q', '-b', 'other', 'main');
    writeFileSync(join(repo, 'dirty.txt'), 'x\n');
    git(repo, 'add', 'dirty.txt');
    git(repo, 'rm', '-q', '--cached', 'tracked.txt');
    git(repo, 'commit', '-q', '-m', 'untrack tracked.txt on other');
    writeFileSync(join(repo, 'tracked.txt'), 'untracked-clash\n');
    appendFileSync(join(repo, 'dirty.txt'), 'dirtied\n'); // tracked + dirty: stash has work to do
    const before = git(repo, 'status', '--porcelain');

    const r = spawnSync('bash', [SCRIPT, 'feature-branch'], { cwd: repo, encoding: 'utf8', env: ENV });
    assert.notEqual(r.status, 0, `exit code lied (0) after a checkout failure:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /could not checkout main/);
    assert.equal(git(repo, 'stash', 'list').trim(), '', 'stash abandoned after checkout failure');
    assert.equal(git(repo, 'status', '--porcelain'), before, 'working tree not restored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const sig of ['TERM', 'HUP', 'INT']) {
  test(`killed by SIG${sig} while holding its stash: stash is restored, exit non-zero`, async () => {
    const marker = join(tmpdir(), `bro2904-marker-${process.pid}-${sig}`);
    rmSync(marker, { force: true });
    // The audit step runs after the stash + merges and before the push: park there.
    const { root, repo } = fixture(`#!/usr/bin/env bash\ntouch ${marker}\nsleep 60\n`);
    let child;
    try {
      chmodSync(join(repo, 'scripts/lib/run-push-audits.sh'), 0o755);
      appendFileSync(join(repo, 'tracked.txt'), 'daemon churn\n');
      const before = git(repo, 'status', '--porcelain');
      child = spawn('bash', [SCRIPT, 'feature-branch'], { cwd: repo, env: ENV, detached: true, stdio: 'ignore' });
      const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
      for (let i = 0; i < 300 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(marker), 'script never reached the audit step (fixture broken)');
      assert.match(git(repo, 'stash', 'list'), /wt-integ-/, 'precondition: the script is holding a stash');
      process.kill(-child.pid, `SIG${sig}`); // whole group: the sleeping audit dies too
      const { code, signal } = await exited;
      assert.ok(code !== 0 || signal, `exited 0 after SIG${sig}`);
      assert.equal(git(repo, 'stash', 'list').trim(), '', `stash abandoned after SIG${sig}`);
      assert.match(git(repo, 'status', '--porcelain'), /tracked\.txt/, 'stashed change not restored');
      assert.equal(before.includes('tracked.txt'), true);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(root, { recursive: true, force: true }); rmSync(marker, { force: true }); }
  });
}

// ── BRO-2884: landing CI-coverage guard (a [skip ci] tip must not leave a landing without CI) ──
const require = createRequire(import.meta.url);
const lib = require('./lib/landing-ci-coverage.js');
const LIB_PATH = join(HERE, 'lib', 'landing-ci-coverage.js');
const LAND_SCRIPT = SCRIPT;

const gitq = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// main: base <- merge M (code change) <- T ("data: audit telemetry update [skip ci]")
function ciFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bro2884-'));
  gitq(dir, 'init', '-q', '-b', 'main');
  gitq(dir, 'config', 'user.email', 't@t'); gitq(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a'); gitq(dir, 'add', '.'); gitq(dir, 'commit', '-qm', 'base');
  gitq(dir, 'checkout', '-qb', 'wt');
  mkdirSync(join(dir, 'scripts')); writeFileSync(join(dir, 'scripts', 'x.js'), 'x'); gitq(dir, 'add', '.'); gitq(dir, 'commit', '-qm', 'feat: change scripts');
  gitq(dir, 'checkout', '-q', 'main');
  gitq(dir, 'merge', '--no-ff', '-qm', 'merge wt', 'wt');
  const M = gitq(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'telemetry.json'), '{}'); gitq(dir, 'add', '.');
  gitq(dir, 'commit', '-qm', 'data: audit telemetry update [skip ci]');
  const T = gitq(dir, 'rev-parse', 'HEAD');
  return { dir, M, T };
}

test('hasSkipCiMarker matches GitHub skip directives only', () => {
  for (const m of ['x [skip ci]', 'x [ci skip]', 'x [no ci]', 'x\n\nskip-checks: true', 'X [SKIP CI]']) assert.ok(lib.hasSkipCiMarker(m), m);
  for (const m of ['skip ci tests', 'fix: skipping ci', '', undefined]) assert.ok(!lib.hasSkipCiMarker(m), String(m));
});

test('findCoveringRun: descendant head_sha covers; unrelated/cancelled do not', () => {
  const { dir, M, T } = ciFixture();
  const anc = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir }).status === 0;
  assert.equal(lib.findCoveringRun([{ head_sha: T }], M, anc).head_sha, T);
  assert.equal(lib.findCoveringRun([{ head_sha: M }], M, anc).head_sha, M);
  assert.equal(lib.findCoveringRun([{ head_sha: T, conclusion: 'cancelled' }], M, anc), null);
  assert.equal(lib.findCoveringRun([{ head_sha: gitq(dir, 'rev-parse', 'wt~1') }], M, anc), null, 'an older commit does not cover M');
  assert.equal(lib.findCoveringRun([], M, anc), null);
});

test('ensureCoverage: skip-ci tip with no run → dispatches, dispatched run covers the merge', async () => {
  const { dir, M, T } = ciFixture();
  const anc = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir }).status === 0;
  const runs = []; let dispatched = 0;
  const res = await lib.ensureCoverage({
    sha: T, // landed tip IS the telemetry commit: the exact push-tip shape from the incident
    listRuns: async () => runs, isAncestor: anc,
    getMessage: s => gitq(dir, 'log', '-1', '--format=%B', s),
    getChangedFiles: () => ['scripts/x.js'],
    dispatch: async () => { dispatched++; runs.push({ head_sha: T, event: 'workflow_dispatch' }); },
    sleep: async () => {}, waitSec: 30, pollSec: 15,
  });
  assert.equal(dispatched, 1);
  assert.equal(res.status, 'dispatched-covered');
  assert.ok(anc(M, res.run.head_sha), 'the merge commit is an ancestor of the covering run head_sha');
});

test('ensureCoverage: without dispatch the same shape is UNCOVERED (guards the guard)', async () => {
  const { dir, M } = ciFixture();
  const anc = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir }).status === 0;
  const res = await lib.ensureCoverage({
    sha: M, listRuns: async () => [], isAncestor: anc,
    getMessage: () => 'x [skip ci]', getChangedFiles: () => ['src/a.ts'],
    dispatch: async () => {}, sleep: async () => {}, waitSec: 15, pollSec: 15,
  });
  assert.equal(res.status, 'uncovered');
});

test('ensureCoverage: data-only landing without skip marker needs no run', async () => {
  const res = await lib.ensureCoverage({
    sha: 'abc', listRuns: async () => [], isAncestor: () => false,
    getMessage: () => 'data: x', getChangedFiles: () => ['data/audit/x.json'], pushPaths: ['src/**'],
    dispatch: async () => assert.fail('must not dispatch'), sleep: async () => {},
  });
  assert.equal(res.status, 'not-required');
});

test('CLI end-to-end: merge M under skip-ci tip T, stub gh → dispatch → run head_sha has M as ancestor', () => {
  const { dir, M, T } = ciFixture();
  const stubDir = mkdtempSync(join(tmpdir(), 'bro2884-gh-'));
  const state = join(stubDir, 'runs.json'); writeFileSync(state, '[]');
  const gh = join(stubDir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
if [ "$1" = "api" ]; then cat "${state}"; exit 0; fi
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then echo '[{"head_sha":"${T}","conclusion":null,"event":"workflow_dispatch","html_url":"https://example/run/1"}]' > "${state}"; exit 0; fi
exit 1
`);
  chmodSync(gh, 0o755);
  const r = spawnSync('node', [LIB_PATH, `--sha=${M}`, `--cwd=${dir}`, '--repo=o/r', '--wait-sec=15'], { encoding: 'utf8', env: { ...process.env, GH_BIN: gh } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dispatched test\.yml on main/);
  assert.match(r.stdout, /CI-COVERAGE: OK/);
  const runs = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', M, runs[0].head_sha], { cwd: dir }).status, 0);

  // detection: a gh that creates nothing → UNCOVERED, exit 1
  writeFileSync(gh, '#!/usr/bin/env bash\nif [ "$1" = "api" ]; then echo "[]"; exit 0; fi\nexit 0\n');
  const bad = spawnSync('node', [LIB_PATH, `--sha=${M}`, `--cwd=${dir}`, '--repo=o/r', '--wait-sec=1'], { encoding: 'utf8', env: { ...process.env, GH_BIN: gh } });
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /UNCOVERED/);
});

test('the landing script wires the coverage check into prove_and_finish', () => {
  const src = readFileSync(LAND_SCRIPT, 'utf8');
  const fn = src.slice(src.indexOf('prove_and_finish() {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /landing-ci-coverage\.js/);
  assert.ok(body.indexOf('landing-ci-coverage.js') < body.indexOf('echo "LANDED:'), 'checked before LANDED is reported');
  assert.ok(existsSync(LIB_PATH));
});

test('touchesCodePaths follows the workflow push paths, not a prefix guess', () => {
  const wf = `on:\n  push:\n    branches: [main]\n    paths:\n      - 'src/**'\n      - 'scripts/lib/**'\n      # c\n      - 'scripts/one.js'\n  pull_request:\n    branches: [main]\n  schedule:\n    - cron: '0 6 * * *'\n`;
  const pats = lib.pushPathsFromWorkflow(wf);
  assert.deepEqual(pats, ['src/**', 'scripts/lib/**', 'scripts/one.js']);
  assert.ok(lib.touchesCodePaths(['scripts/lib/a/b.js'], pats));
  assert.ok(lib.touchesCodePaths(['scripts/one.js'], pats));
  assert.ok(!lib.touchesCodePaths(['scripts/other.js', 'data/x.json'], pats), 'filtered script does not trigger an expensive dispatch');
  assert.ok(lib.touchesCodePaths([], pats), 'unknown file list is treated as needing a run (resume path: fork == tip)');
  assert.ok(lib.touchesCodePaths(['a'], []), 'unknown paths → safe direction');
  const real = lib.pushPathsFromWorkflow(readFileSync(join(HERE, '..', '.github', 'workflows', 'test.yml'), 'utf8'));
  assert.ok(real.includes('src/**') && real.includes('scripts/lib/**'), 'parses the real test.yml');
});

test('ensureCoverage: gh listing failure is unknown and never dispatches', async () => {
  const res = await lib.ensureCoverage({
    sha: 'abc', listRuns: async () => null, isAncestor: () => false,
    getMessage: () => 'x [skip ci]', getChangedFiles: () => ['src/a.ts'],
    dispatch: async () => assert.fail('must not dispatch on unknown'), sleep: async () => {},
  });
  assert.equal(res.status, 'unknown');
});
