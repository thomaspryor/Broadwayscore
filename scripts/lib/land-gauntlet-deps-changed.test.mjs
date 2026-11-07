/**
 * BRO-6114: land-gauntlet.sh --deps-changed must really reinstall the base
 * tree's node_modules before judging it. npm_ci logged into <out-dir> before
 * the script created it, and land.yml rm -rf's that dir first, so npm ci never
 * ran: the base was judged on the BRANCH's node_modules and the Next 16 bump
 * landed a new tsc-llm-scoring failure as "red on base too".
 *
 * Runs the real script in a throwaway git repo with a stub npm on PATH and no
 * gates selected. The env is built from scratch on purpose: this file also
 * runs inside the gauntlet's own scripts-lib-tests gate, whose step exports
 * GAUNTLET_* variables that would change the script's behaviour.
 *
 * Run: node --test scripts/lib/land-gauntlet-deps-changed.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOTS = [];
after(() => { for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'gauntlet-deps-')));
  ROOTS.push(root);
  const repo = join(root, 'repo');
  const harness = join(root, 'harness');
  const bin = join(root, 'bin');
  for (const d of [repo, harness, bin]) fs.mkdirSync(d);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  fs.writeFileSync(join(repo, 'package.json'), '{"name":"base"}\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(join(repo, 'package.json'), '{"name":"branch"}\n');
  git('commit', '-q', '-am', 'branch bumps deps');
  const branch = git('rev-parse', 'HEAD');
  for (const name of ['land-gauntlet.sh', 'tsc-node-options.sh']) fs.copyFileSync(join(HERE, name), join(harness, name));
  // Stub npm: records "<call#> <package name>" and fails the call numbers in NPM_STUB_FAIL.
  const calls = join(root, 'npm-calls.txt');
  fs.writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash
n=$(( $(wc -l < "${calls}" 2>/dev/null || echo 0) + 1 ))
echo "$n $(sed -n 's/.*"name":"\\([a-z]*\\)".*/\\1/p' package.json) $*" >> "${calls}"
[[ ",\${NPM_STUB_FAIL:-}," == *",$n,"* ]] && { echo "stub npm: failing call $n" >&2; exit 1; }
exit 0
`, { mode: 0o755 });
  return { root, repo, harness, bin, calls, base, branch, git };
}

function runGauntlet(ctx, npmFail = '') {
  const out = join(ctx.root, 'out', 'base'); // does not exist, like land.yml after its rm -rf
  const env = {
    PATH: `${ctx.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: ctx.root,
    GAUNTLET_GATES: '__none__',
    GAUNTLET_NPM_RETRY_SEC: '0',
    NPM_STUB_FAIL: npmFail,
  };
  const r = spawnSync('bash', [join(ctx.harness, 'land-gauntlet.sh'), out, '--checkout', ctx.base, '--return-to', ctx.branch, '--deps-changed'],
    { cwd: ctx.repo, env, encoding: 'utf8' });
  const calls = fs.existsSync(ctx.calls) ? fs.readFileSync(ctx.calls, 'utf8').trim().split('\n') : [];
  return { ...r, out, calls, head: ctx.git('rev-parse', 'HEAD'), log: r.stdout + r.stderr };
}

test('absent out-dir: npm ci runs on the base tree, then again on the return tree', () => {
  const ctx = setup();
  const r = runGauntlet(ctx);
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.map((l) => l.split(' ').slice(1, 3).join(' ')), ['base ci', 'branch ci']);
  assert.ok(fs.existsSync(join(r.out, 'meta.json')), 'the run reached meta.json');
  assert.equal(JSON.parse(fs.readFileSync(join(r.out, 'meta.json'), 'utf8')).sha, ctx.base, 'judged the base tree');
  assert.equal(r.head, ctx.branch, 'returned to the branch');
  assert.doesNotMatch(r.log, /prep-npm-ci-[a-z]+\.log: No such file/, "the npm ci log redirect works");
});

test('one failed install is retried, and the run carries on', () => {
  const ctx = setup();
  const r = runGauntlet(ctx, '1');
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.map((l) => l.split(' ')[1]), ['base', 'base', 'branch']);
  assert.ok(fs.existsSync(join(r.out, 'meta.json')));
});

test('a base install that fails twice refuses to judge the base (exit 1), and still returns', () => {
  const ctx = setup();
  const r = runGauntlet(ctx, '1,2');
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /::error::npm ci on [0-9a-f]{10} failed twice/);
  assert.doesNotMatch(r.log, /judging /, 'no gate ran on the wrong node_modules');
  assert.ok(!fs.existsSync(join(r.out, 'meta.json')), 'no result is written for a base it could not install');
  assert.equal(r.head, ctx.branch, 'returned to the branch');
  assert.equal(r.calls.at(-1).split(' ')[1], 'branch', 'the return tree is reinstalled');
});

test('a return-side install that fails twice only warns: the measurement is complete', () => {
  const ctx = setup();
  const r = runGauntlet(ctx, '2,3');
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /::warning::npm ci \(return\) failed twice/);
  assert.ok(fs.existsSync(join(r.out, 'meta.json')));
  assert.equal(r.head, ctx.branch);
});
