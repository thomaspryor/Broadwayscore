// BRO-5414: a long collect run carries an in-run checkpoint commit plus its
// final commit. When both conflict with the remote on rebase, the push loop
// used to resolve the first, `git rebase --continue` stopped on the second,
// and it pushed the pre-rebase branch: rejected 5/5, all work lost
// (collect-review-texts runs 38752255687, 38726965159, 38711566877). Runs the
// action's real script against a local bare origin (harness as in
// push-review-texts-owed-commits.test.mjs).
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
const ff = (ids) => JSON.stringify(ids.map((id) => ({ reviewId: id, failureReason: 'all_tiers_timeout', failureCount: 1 })), null, 2) + '\n';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rt-multi-'));
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
  fs.writeFileSync(path.join(seed, 'failed-fetches.json'), ff(['base/x.json']));
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(tmp, 'clone', '-q', '--depth', '1', '--branch', 'main', `file://${origin}`, rt);
  git(rt, 'config', 'user.email', 't@t'); git(rt, 'config', 'user.name', 't');
  const out = path.join(tmp, 'gh-output');
  fs.writeFileSync(out, '');
  return { tmp, origin, ws, rt, out, seed };
}

function runAction({ ws, rt, out, origin }) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], {
    cwd: rt, encoding: 'utf8', timeout: 170000,
    env: {
      ...CLEAN_ENV, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out, REVIEW_TEXTS_TOKEN: TOKEN, COMMIT_MSG: 'data: final',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`, GIT_CONFIG_VALUE_0: URL_IN_ACTION,
    },
  });
}

test('three local commits that each conflict on rebase are all pushed', { timeout: 180000 }, () => {
  const s = setup();
  try {
    // Two in-run checkpoint commits (local, unpushed).
    fs.writeFileSync(path.join(s.rt, 'failed-fetches.json'), ff(['base/x.json', 'run/checkpoint.json']));
    fs.writeFileSync(path.join(s.rt, 'show-a', 'two.json'), '{"b":2}\n');
    git(s.rt, 'add', '-A'); git(s.rt, 'commit', '-qm', 'chore: Checkpoint review texts (1 collected)');
    fs.writeFileSync(path.join(s.rt, 'notes.txt'), 'run checkpoint 2\n');
    git(s.rt, 'add', '-A'); git(s.rt, 'commit', '-qm', 'chore: Checkpoint review texts (2 collected)');
    // Another workflow pushes changes to the same files meanwhile.
    fs.writeFileSync(path.join(s.seed, 'failed-fetches.json'), ff(['base/x.json', 'other/workflow.json']));
    fs.writeFileSync(path.join(s.seed, 'notes.txt'), 'other workflow\n');
    git(s.seed, 'add', '-A'); git(s.seed, 'commit', '-qm', 'other workflow'); git(s.seed, 'push', '-q', 'origin', 'HEAD:main');
    // The run's final, uncommitted work touches the failed-fetches file again.
    fs.writeFileSync(path.join(s.rt, 'failed-fetches.json'), ff(['base/x.json', 'run/checkpoint.json', 'run/final.json']));
    fs.writeFileSync(path.join(s.rt, 'show-a', 'three.json'), '{"c":3}\n');

    const r = runAction(s);
    if (process.env.DBG) fs.writeFileSync(process.env.DBG, r.stdout + "\n----\n" + r.stderr);
    assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-3000));
    assert.match(fs.readFileSync(s.out, 'utf8'), /pushed=true/);
    const log = git(s.origin, 'log', '--format=%s', 'main');
    assert.match(log, /Checkpoint review texts \(1 collected\)/);
    assert.match(log, /Checkpoint review texts \(2 collected\)/);
    assert.match(log, /other workflow/);
    const tree = git(s.origin, 'ls-tree', '-r', '--name-only', 'main');
    assert.match(tree, /show-a\/two\.json/);
    assert.match(tree, /show-a\/three\.json/);
    const ids = JSON.parse(git(s.origin, 'show', 'main:failed-fetches.json')).map((e) => e.reviewId).sort();
    assert.deepEqual(ids, ['base/x.json', 'other/workflow.json', 'run/checkpoint.json', 'run/final.json']);
    assert.equal(fs.existsSync(path.join(s.rt, git(s.rt, 'rev-parse', '--git-path', 'rebase-merge'))), false, 'no rebase left in progress');
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
