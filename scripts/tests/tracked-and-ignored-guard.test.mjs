/**
 * tracked-and-ignored-guard.test.mjs — prevention lint for task #1759.
 *
 * data/opening-night-sent.json and data/outlet-registry.json were BOTH
 * git-tracked in the public repo while also being shipped by
 * checkout-core-data's `cp -f /tmp/core-data-checkout/*.json data/`. That
 * combination dirties a tracked path on every checkout-core-data run, and
 * the very next `git checkout <branch>` in that job aborts — the confirmed
 * root cause of the 2026-08-17 autonomous-merge outage (four green PRs sat
 * unmerged for a day). See scripts/lib/tracked-and-ignored-guard.js.
 *
 * The real-repo-state test below is the actual regression guard: it fails
 * if either file (or any other core-data file) is ever re-added to the git
 * index while still being gitignored and shipped by checkout-core-data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getShippedCoreFiles, getTrackedAndIgnored, findTrackedAndShipped } = require('../lib/tracked-and-ignored-guard.js');

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.join(__dirname, '..', '..');

test('getShippedCoreFiles: parses CORE_FILES out of the real push-core-data/action.yml', () => {
  const files = getShippedCoreFiles();
  assert.ok(files.includes('opening-night-sent.json'), 'opening-night-sent.json must still be a shipped core file');
  assert.ok(files.includes('outlet-registry.json'), 'outlet-registry.json must still be a shipped core file');
  assert.ok(files.includes('shows.json'), 'sanity check — shows.json is always shipped');
});

/** A throwaway repo + fake push-core-data action for fixture-level assertions. */
function makeFixture({ trackedFiles = [], shippedFiles = ['shows.json', 'outlet-registry.json'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taig-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@e.st']);
  g(['config', 'user.name', 'test']);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/*.json\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  g(['add', 'README.md']);
  for (const f of trackedFiles) {
    fs.writeFileSync(path.join(dir, 'data', f), '{}\n');
    g(['add', '-f', `data/${f}`]);
  }
  g(['commit', '-qm', 'base']);

  const actionDir = path.join(dir, '.github', 'actions', 'push-core-data');
  fs.mkdirSync(actionDir, { recursive: true });
  const actionPath = path.join(actionDir, 'action.yml');
  fs.writeFileSync(actionPath, `runs:\n  steps:\n    - run: |\n        CORE_FILES="${shippedFiles.join(' ')}"\n`);

  return { dir, actionPath };
}

test('findTrackedAndShipped: empty when nothing tracked-and-ignored overlaps the shipped set', () => {
  const { dir, actionPath } = makeFixture({ trackedFiles: [], shippedFiles: ['shows.json', 'outlet-registry.json'] });
  try {
    assert.deepEqual(findTrackedAndShipped({ cwd: dir, actionPath }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findTrackedAndShipped: flags a file that is both tracked+ignored and shipped', () => {
  const { dir, actionPath } = makeFixture({
    trackedFiles: ['outlet-registry.json'],
    shippedFiles: ['shows.json', 'outlet-registry.json'],
  });
  try {
    assert.deepEqual(findTrackedAndShipped({ cwd: dir, actionPath }), ['data/outlet-registry.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findTrackedAndShipped: a tracked file NOT in the shipped set is not flagged', () => {
  const { dir, actionPath } = makeFixture({
    trackedFiles: ['manually-tracked.json'],
    shippedFiles: ['shows.json', 'outlet-registry.json'],
  });
  try {
    assert.deepEqual(findTrackedAndShipped({ cwd: dir, actionPath }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getTrackedAndIgnored: only reports paths that are both tracked and gitignored', () => {
  const { dir } = makeFixture({ trackedFiles: ['outlet-registry.json'] });
  try {
    assert.deepEqual(getTrackedAndIgnored({ cwd: dir }), ['data/outlet-registry.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL REPO STATE: no data/*.json file is both git-tracked and shipped by checkout-core-data', () => {
  // This is the actual regression guard (task #1759 acceptance criteria).
  // It runs against THIS repo's real git index, not a fixture — so it fails
  // the moment opening-night-sent.json, outlet-registry.json, or any other
  // core-data file is re-added to the tracked index while still gitignored.
  const offenders = findTrackedAndShipped({ cwd: REPO_ROOT });
  assert.deepEqual(offenders, [],
    'these data/*.json files are both git-tracked AND shipped by checkout-core-data — '
      + 'checkout-core-data\'s cp -f will dirty them on every run and abort the next git checkout '
      + '(2026-08-17 autonomous-merge outage). Run: git rm --cached <file> (keep it on disk).');
});
