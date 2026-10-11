// TESTS-VS-DERIVED-DATA-EXEMPT: synthetic fixtures only; never reads real data/*.json.
/**
 * BRO-5033: workflow "did core data change?" checks.
 *
 * Core data files are gitignored, so `git diff data/shows.json` in a workflow
 * is always empty. These tests pin:
 *   - changedCoreFiles() / core-data-changed.js: the snapshot compare that
 *     replaced those checks (same table as push-core-data);
 *   - findGitDiffOnIgnoredPaths(): audit-workflow-hygiene rule (q), which
 *     flags a workflow that diffs an ignored path again.
 * Real functions are require()d (CLAUDE.md §15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { changedCoreFiles } = require('../../scripts/lib/core-data-sync-decision.js');
const { findGitDiffOnIgnoredPaths } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/lib/core-data-changed.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5033-'));
  const dataDir = path.join(root, 'data');
  const snapshotDir = path.join(root, 'snap');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(snapshotDir);
  const put = (dir, f, body) => fs.writeFileSync(path.join(dir, f), body);
  put(dataDir, 'shows.json', '{"a":1}');
  put(snapshotDir, 'shows.json', '{"a":1}');
  put(dataDir, 'grosses.json', '{"w":2}');
  put(snapshotDir, 'grosses.json', '{"w":1}');
  put(dataDir, 'grosses-history.json', '{}'); // new: no snapshot copy
  put(snapshotDir, 'reviews.json', '[]'); // missing from data/
  return { root, dataDir, snapshotDir };
}

describe('changedCoreFiles', () => {
  test('identical file is unchanged, edited and new files are changed', () => {
    const { dataDir, snapshotDir } = fixture();
    const r = changedCoreFiles(['shows.json', 'data/grosses.json', 'grosses-history.json'], { dataDir, snapshotDir });
    assert.deepStrictEqual(r, { snapshotMissing: false, changed: ['grosses.json', 'grosses-history.json'] });
  });

  test('file missing from data/ counts as unchanged (push-core-data skip-missing)', () => {
    const { dataDir, snapshotDir } = fixture();
    assert.deepStrictEqual(changedCoreFiles(['reviews.json'], { dataDir, snapshotDir }).changed, []);
  });

  test('missing snapshot dir is reported, not guessed', () => {
    const { dataDir, root } = fixture();
    const r = changedCoreFiles(['shows.json'], { dataDir, snapshotDir: path.join(root, 'nope') });
    assert.strictEqual(r.snapshotMissing, true);
  });
});

describe('core-data-changed.js CLI exit codes', () => {
  const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

  test('0 when changed, 1 when not, 2 on no args', () => {
    const { dataDir, snapshotDir } = fixture();
    const env = { CORE_DATA_DIR: dataDir, CORE_DATA_SNAPSHOT_DIR: snapshotDir };
    assert.strictEqual(run(['grosses.json'], env).status, 0);
    assert.strictEqual(run(['shows.json'], env).status, 1);
    assert.strictEqual(run(['shows.json', 'grosses.json'], env).status, 0);
    assert.strictEqual(run([], env).status, 2);
  });

  test('missing snapshot fails open (exit 0 with a warning)', () => {
    const { dataDir, root } = fixture();
    const r = run(['shows.json'], { CORE_DATA_DIR: dataDir, CORE_DATA_SNAPSHOT_DIR: path.join(root, 'nope') });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /::warning::/);
  });
});

describe('findGitDiffOnIgnoredPaths (rule q)', () => {
  const ignored = new Set(['data/shows.json', 'data/reviews.json', 'data/grosses.json']);
  const isIgnored = (p) => ignored.has(p);
  const wf = (body) => `jobs:\n  j:\n    steps:\n      - run: |\n${body.split('\n').map((l) => `          ${l}`).join('\n')}\n`;

  test('flags the BRO-5033 shapes', () => {
    const raw = wf([
      'if git diff --quiet data/grosses.json data/grosses-history.json 2>/dev/null; then',
      'git diff --exit-code data/shows.json || echo "changes=true" >> $GITHUB_OUTPUT',
      'BASE=$(git show HEAD:data/reviews.json | wc -c)',
    ].join('\n'));
    const paths = findGitDiffOnIgnoredPaths(raw, isIgnored).map((h) => h.path);
    assert.deepStrictEqual(paths, ['data/grosses.json', 'data/shows.json', 'data/reviews.json']);
  });

  test('flags git global options and backslash continuations', () => {
    const raw = wf([
      'git --no-pager diff data/shows.json',
      'git -C . diff --quiet data/reviews.json || true',
      'if ! git diff --quiet \\',
      '    data/grosses.json; then echo x; fi',
    ].join('\n'));
    const paths = findGitDiffOnIgnoredPaths(raw, isIgnored).map((h) => h.path);
    assert.deepStrictEqual(paths, ['data/shows.json', 'data/reviews.json', 'data/grosses.json']);
  });

  test('tracked paths, expansions, comments and exempt lines are not flagged', () => {
    const raw = wf([
      'if ! git diff --quiet public/data/shows/ 2>/dev/null; then',
      'git diff "$BASE" --name-only -- data/tony-loso-stats.json',
      '# git diff --quiet data/shows.json',
      'git status --porcelain data/shows.json # hygiene-ignored-diff-ok: proves the file is untracked',
      'git diff --quiet data/ && echo data/shows.json',
    ].join('\n'));
    assert.deepStrictEqual(findGitDiffOnIgnoredPaths(raw, isIgnored), []);
  });
});
