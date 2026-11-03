// BRO-6886: push-review-texts records the review files each push carries so its
// post-push step can start scoring for new unscored press-night reviews right
// away (score-new-press-night-reviews.js). Runs the action's real push script
// against a local bare origin, like push-review-texts-owed-commits.test.mjs.
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
const SCRIPT = step.run.split('\n').filter((l) => !l.includes('opening-night-lease.js')).join('\n');
const TOKEN = 'test-token';
const URL_IN_ACTION = `https://x-access-token:${TOKEN}@github.com/thomaspryor/broadway-review-texts.git`;
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX)$/.test(k)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: CLEAN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rt-list-'));
  const origin = path.join(tmp, 'origin.git');
  const ws = path.join(tmp, 'ws');
  const rt = path.join(ws, 'data', 'review-texts');
  const runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
  fs.mkdirSync(runnerTemp);
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
  return { tmp, origin, ws, rt, out, runnerTemp, list: path.join(runnerTemp, 'review-texts-pushed-files.txt') };
}

function runAction({ rt, ws, out, origin, runnerTemp }) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], {
    cwd: rt,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...CLEAN_ENV,
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

const listed = (s) => (fs.existsSync(s.list) ? fs.readFileSync(s.list, 'utf8').split('\n').filter(Boolean) : []);
const cleanup = (s) => fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test('a pushed new review file and an owed checkpoint file are both listed', () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.rt, 'show-b'));
    fs.writeFileSync(path.join(s.rt, 'show-b', 'owed.json'), '{"o":1}\n');
    git(s.rt, 'add', '-A'); git(s.rt, 'commit', '-qm', 'chore: Checkpoint');
    fs.writeFileSync(path.join(s.rt, 'show-a', 'nytg--critic.json'), '{"n":1}\n');
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
    const files = listed(s);
    assert.ok(files.includes('show-a/nytg--critic.json'), files.join(','));
    assert.ok(files.includes('show-b/owed.json'), files.join(','));
    assert.ok(!files.includes('show-a/one.json'), 'unchanged files are not listed');
  } finally { cleanup(s); }
});

test('files pushed mid-run (BRO-5308 marker) are listed even with nothing left to push', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.rt, 'show-a', 'mid-run.json'), '{"m":1}\n');
    git(s.rt, 'add', '-A'); git(s.rt, 'commit', '-qm', 'checkpoint');
    git(s.rt, 'push', '-q', `file://${s.origin}`, 'HEAD:main');
    git(s.rt, 'fetch', '-q', `file://${s.origin}`, 'main:refs/remotes/origin/main');
    fs.writeFileSync(path.join(s.runnerTemp, 'review-texts-pushed.marker'), 'x');
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
    assert.deepEqual(listed(s), ['show-a/mid-run.json']);
  } finally { cleanup(s); }
});

test('nothing to push leaves no list', () => {
  const s = setup();
  try {
    const r = runAction(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(listed(s), []);
  } finally { cleanup(s); }
});

test('the dispatch step runs only after a successful push and calls the real script', () => {
  const d = action.runs.steps.find((st) => /BRO-6886/.test(st.name || ''));
  assert.ok(d, 'dispatch step exists');
  assert.match(d.if, /steps\.push\.outputs\.pushed == 'true'/);
  assert.match(d.if, /inputs\.dispatch_scoring != 'false'/);
  assert.match(d.run, /scripts\/score-new-press-night-reviews\.js/);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/score-new-press-night-reviews.js')));
});

test('the scoring workflow opts out, so it never re-dispatches itself', () => {
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/llm-ensemble-score.yml'), 'utf8'));
  const uses = Object.values(wf.jobs).flatMap((j) => j.steps || []).filter((st) => st.uses === './.github/actions/push-review-texts');
  assert.ok(uses.length > 0);
  for (const st of uses) assert.equal(String(st.with && st.with.dispatch_scoring), 'false');
});
