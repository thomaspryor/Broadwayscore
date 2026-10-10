import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'stage-data-changes.sh');

// Regression coverage for the BRO-1226 incident: `git add <dir>/ ':!<other>/'`
// (a positive directory pathspec with a trailing slash, listed BEFORE a `:!`
// magic exclude pathspec) silently stages ZERO files on git 2.50.1 — no
// error, exit 0. This bit snapshot-award-scores.js for 10+ weekly cron runs.
// These tests run the real script against a disposable git repo (never the
// real checkout) so the fix's generality is asserted, not just the single
// case that was manually reproduced.

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-data-changes-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function stagedFiles(dir) {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

test('stages a new file in a single directory passed with a trailing slash (the exact regression case)', () => {
  const dir = makeTempRepo();
  fs.mkdirSync(path.join(dir, 'data', 'award-score-history'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'aggregator-archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'award-score-history', '2026-05-23.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data', 'aggregator-archive', 'archived.json'), '{}');

  execFileSync('bash', [SCRIPT, 'data/award-score-history/'], { cwd: dir });

  assert.deepEqual(stagedFiles(dir), ['data/award-score-history/2026-05-23.json']);
});

test('stages multiple positive directories, each with a trailing slash', () => {
  const dir = makeTempRepo();
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'collection-state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'audit', 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data', 'collection-state', 'b.json'), '{}');

  execFileSync('bash', [SCRIPT, 'data/audit/', 'data/collection-state/'], { cwd: dir });

  assert.deepEqual(stagedFiles(dir), ['data/audit/a.json', 'data/collection-state/b.json']);
});

test('default (no arguments) stages all of data/ with a trailing-slash implicit default', () => {
  const dir = makeTempRepo();
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'audit', 'a.json'), '{}');

  execFileSync('bash', [SCRIPT], { cwd: dir });

  assert.deepEqual(stagedFiles(dir), ['data/audit/a.json']);
});

test('never stages the private exclusion paths even when they sit inside a staged directory', () => {
  const dir = makeTempRepo();
  fs.mkdirSync(path.join(dir, 'data', 'aggregator-archive', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'review-texts', 'show-a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'finances'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'aggregator-archive', 'nested', 'x.html'), '<html>');
  fs.writeFileSync(path.join(dir, 'data', 'review-texts', 'show-a', 'review.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data', 'finances', 'ledger.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data', 'audit', 'ok.json'), '{}');

  execFileSync('bash', [SCRIPT], { cwd: dir });

  assert.deepEqual(stagedFiles(dir), ['data/audit/ok.json']);
});

test('a caller passing a directory without a trailing slash still stages correctly (no regression in the other direction)', () => {
  const dir = makeTempRepo();
  fs.mkdirSync(path.join(dir, 'data', 'award-score-history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'award-score-history', '2026-05-23.json'), '{}');

  execFileSync('bash', [SCRIPT, 'data/award-score-history'], { cwd: dir });

  assert.deepEqual(stagedFiles(dir), ['data/award-score-history/2026-05-23.json']);
});
