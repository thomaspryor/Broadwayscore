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
  return { tmp, origin, ws, rt, out };
}

function runAction({ ws, rt, out, origin }) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], {
    cwd: rt,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...CLEAN_ENV,
      GITHUB_WORKSPACE: ws,
      GITHUB_OUTPUT: out,
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
