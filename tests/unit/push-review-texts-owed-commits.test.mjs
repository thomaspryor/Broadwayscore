// BRO-5261 S15 (BRO-3599 follow-on): push-review-texts used to exit 0 on a
// clean index, so a mid-run checkpoint commit whose own push had failed
// (collect-review-texts.js pushReviewTextsCheckpoint, the recover-* scripts)
// was never pushed and was lost when the job ended. Runs the action's real
// run script against a local bare origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const action = yaml.load(fs.readFileSync(path.join(ROOT, '.github/actions/push-review-texts/action.yml'), 'utf8'));
const step = action.runs.steps.find((s) => s.id === 'push');
// The lease sync/enforce lines fetch the shared lease store over the network
// and are not what this test is about.
const SCRIPT = step.run.split('\n').filter((l) => !l.includes('opening-night-lease.js')).join('\n');
const TOKEN = 'test-token';
const { MARKER_NAME } = require(path.join(ROOT, 'scripts/lib/review-texts-pushed-marker.js'));
const URL_IN_ACTION = `https://x-access-token:${TOKEN}@github.com/thomaspryor/broadway-review-texts.git`;

// Inside a git hook or land gate GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE are set
// and would point every git call here at the real repo.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX)$/.test(k)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: CLEAN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rt-owed-'));
  const origin = path.join(tmp, 'origin.git');
  const ws = path.join(tmp, 'ws');
  const rt = path.join(ws, 'data', 'review-texts');
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(ws, 'scripts'));
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(tmp, 'seed');
  git(tmp, 'clone', '-q', origin, seed);
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(seed, 'show-a'));
  fs.writeFileSync(path.join(seed, 'show-a', 'one.json'), '{"a":1}\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(tmp, 'clone', '-q', '--depth', '1', '--branch', 'main', `file://${origin}`, rt);
  git(rt, 'config', 'user.email', 't@t'); git(rt, 'config', 'user.name', 't');
  const out = path.join(tmp, 'gh-output');
  fs.writeFileSync(out, '');
  // BRO-7948: the action reports pushed=true when $RUNNER_TEMP holds the
  // "earlier in-job push" marker. On an Actions runner the inherited
  // RUNNER_TEMP is the whole job's temp dir, where other tests had left that
  // marker, so every case gets its own.
  const runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(runnerTemp);
  return { tmp, origin, ws, rt, out, runnerTemp };
}

function runAction({ ws, rt, out, origin, runnerTemp }, inherited = {}) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], {
    cwd: rt,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...CLEAN_ENV,
      ...inherited,
      GITHUB_WORKSPACE: ws,
      GITHUB_OUTPUT: out,
      RUNNER_TEMP: runnerTemp,
      REVIEW_TEXTS_TOKEN: TOKEN,
      COMMIT_MSG: 'data: test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: URL_IN_ACTION,
    },
  });
}

const originLog = (origin) => git(origin, 'log', '--format=%s', 'main');

test('a clean index with an unpushed checkpoint commit pushes it', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.rt, 'show-a', 'two.json'), '{"b":2}\n');
    git(s.rt, 'add', '-A'); git(s.rt, 'commit', '-qm', 'chore: Checkpoint review texts (1 collected)');
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(originLog(s.origin), /Checkpoint review texts/, 'the owed commit reached origin');
    assert.match(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
    assert.match(r.stdout, /1 earlier commit\(s\) are unpushed/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a clean index with nothing owed exits 0 without pushing', () => {
  const s = setup();
  try {
    const before = originLog(s.origin);
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No review-texts changes to push/);
    assert.equal(originLog(s.origin), before);
    assert.doesNotMatch(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// BRO-7948: this file's "nothing owed" case was red on every land run for
// weeks because it read the job's real RUNNER_TEMP. Seed the marker in the
// inherited dir and show the action under test does not see it.
test('a marker in the inherited RUNNER_TEMP does not leak into the action run', () => {
  const s = setup();
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rt-outer-'));
  try {
    fs.writeFileSync(path.join(outer, MARKER_NAME), '1\n');
    const r = runAction(s, { RUNNER_TEMP: outer });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No review-texts changes to push/);
    assert.doesNotMatch(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a clean index after an earlier in-job push still reports pushed=true', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.runnerTemp, MARKER_NAME), '1\n');
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// Class guard: every test that runs this action's script must hand it a
// RUNNER_TEMP of its own. One that inherits the job's can be fed a stale
// marker (a false pushed=true) and leaves its pushed-files list behind.
test('every test that runs the push-review-texts script sets its own RUNNER_TEMP', () => {
  const dir = path.join(ROOT, 'tests/unit');
  const runners = fs.readdirSync(dir).filter((f) => /\.test\.(mjs|js)$/.test(f)).filter((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    return src.includes('push-review-texts/action.yml') && /spawnSync\(\s*'bash'/.test(src);
  });
  assert.ok(runners.length >= 4, `expected the known runners, found ${runners.join(', ')}`);
  const inheriting = runners.filter((f) => !/RUNNER_TEMP\s*:/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(inheriting, [], 'these tests run the action script with the inherited RUNNER_TEMP');
});

test('a staged change is committed and pushed as before', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.rt, 'show-a', 'three.json'), '{"c":3}\n');
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(originLog(s.origin), /^data: test/);
    assert.match(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
