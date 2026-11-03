// BRO-6886: mid-run review-texts pushes start press-night scoring right away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { listUnpushedReviewFiles, startPressNightScoring } = require('../../scripts/lib/press-night-scoring-trigger.js');
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX)$/.test(k)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: CLEAN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('listUnpushedReviewFiles lists files of local commits ahead of origin/main', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-trigger-'));
  try {
    const origin = path.join(tmp, 'o.git');
    const rt = path.join(tmp, 'rt');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', '-q', origin, rt);
    git(rt, 'config', 'user.email', 't@t'); git(rt, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(rt, 'show-a'));
    fs.writeFileSync(path.join(rt, 'show-a', 'old.json'), '{}\n');
    git(rt, 'add', '-A'); git(rt, 'commit', '-qm', 'base'); git(rt, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(path.join(rt, 'show-a', 'new.json'), '{}\n');
    git(rt, 'add', '-A'); git(rt, 'commit', '-qm', 'checkpoint');
    assert.deepEqual(listUnpushedReviewFiles(rt), ['show-a/new.json']);
    assert.deepEqual(listUnpushedReviewFiles(path.join(tmp, 'missing')), [], 'fail-open');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('startPressNightScoring: no-op outside Actions or with no files', () => {
  let calls = 0;
  const spawn = () => { calls++; return {}; };
  assert.equal(startPressNightScoring(['a/b.json'], { env: {}, spawn }), false);
  assert.equal(startPressNightScoring([], { env: { GITHUB_ACTIONS: 'true' }, spawn }), false);
  assert.equal(calls, 0);
});

test('startPressNightScoring hands the file list to the real CLI and cleans up', () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-rt-'));
  try {
    let seen = null;
    const spawn = (bin, args) => {
      const listArg = args.find((a) => a.startsWith('--files='));
      seen = { cli: args[0], list: fs.readFileSync(listArg.slice(8), 'utf8') };
      return {};
    };
    assert.equal(startPressNightScoring(['show-a/x.json', 'show-b/y.json'], { env: { GITHUB_ACTIONS: 'true', RUNNER_TEMP: runnerTemp }, spawn }), true);
    assert.equal(seen.cli, path.join(ROOT, 'scripts/score-new-press-night-reviews.js'));
    assert.equal(seen.list, 'show-a/x.json\nshow-b/y.json\n');
    assert.deepEqual(fs.readdirSync(runnerTemp), [], 'list file removed');
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test('every mid-run review-texts pusher also starts press-night scoring', () => {
  const scriptsDir = path.join(ROOT, 'scripts');
  const callers = fs.readdirSync(scriptsDir)
    .filter((f) => /\.(c?js|mjs)$/.test(f))
    .filter((f) => /\bmarkReviewTextsPushed\(\)/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8')));
  assert.ok(callers.length >= 4, `found ${callers.join(',')}`);
  for (const f of callers) {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    assert.match(src, /startPressNightScoring\(\w+\)/, `${f} pushes review-texts mid-run but never starts press-night scoring (BRO-6886)`);
    assert.match(src, /listUnpushedReviewFiles\(/, `${f} must capture the files before its push`);
  }
});
