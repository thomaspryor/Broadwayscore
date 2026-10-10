// BRO-4484: end-to-end replay of the OWE promoter's red commit step.
//
// The promoter prunes data/audit/owe-venue-candidates.json, commits, and
// pushes through push-with-retry.sh with PUSH_RECONCILE_MERGED_JSON=1. When
// main moved during the run, the reconcile pass unioned the remote's
// pre-prune rows back, the pushed file equalled the pre-edit base, and the
// content-survival check refused every attempt as REVERTED (scheduled runs
// 36623482752 and 36770462183). This drives the real push-with-retry.sh
// against a throwaway bare remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUSH = path.join(HERE, 'push-with-retry.sh');
const FILE = 'data/audit/owe-venue-candidates.json';
// Throwaway repos only: drop inherited GIT_DIR/GIT_INDEX_FILE/... (a hook
// context would point them at the real repo) and the developer's git config.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const row = (title, extra = {}) => ({ title, venue: 'Park Theatre', source: 'venue-page:park-theatre', candidateHash: `h-${title}`, ...extra });
const write = (dir, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  // No trailing newline: owe-venue-staging.js's writeStaging format (registry newline:false).
  fs.writeFileSync(path.join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

// origin + a "seed" clone standing in for every other writer + the runner.
function setup(t, baseRows) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4484-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const runner = path.join(tmp, 'runner');
  git(tmp, 'init', '-q', '--bare', origin);
  // Global config is nulled above, so auto-maintenance must be off in the bare
  // repo itself: receive-pack spawns it detached there (BRO-4749).
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) git(origin, 'config', k, v);
  git(tmp, 'init', '-q', seed);
  write(seed, FILE, baseRows);
  write(seed, 'other.txt', 'v0\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'push', '-q', origin, 'main');
  git(tmp, 'clone', '-q', '-b', 'main', origin, runner);
  return { tmp, origin, seed, runner };
}

function push(runner, tmp) {
  return spawnSync('bash', [PUSH, '3', 'main'], {
    cwd: runner,
    env: { ...ENV, PUSH_RECONCILE_MERGED_JSON: '1', PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'), PUSH_DEADLINE_SEC: '120' },
    encoding: 'utf8',
    timeout: 180_000,
  });
}

const remoteRows = (origin) => JSON.parse(execFileSync('git', ['--git-dir', origin, 'show', `main:${FILE}`], { encoding: 'utf8' }));

test('the promoter prune survives main moving mid-run (staging file untouched remotely) — push succeeds, file is ours', (t) => {
  const goblin = row('Goblin');
  const flush = row('Flush');
  // Goblin last: the old union appended it back in place, so the pushed file
  // was byte-identical to the base and content-survival said REVERTED.
  const { tmp, origin, seed, runner } = setup(t, [flush, goblin]);

  // Promoter: promoted Goblin, prunes it from staging, commits.
  write(runner, FILE, [flush]);
  write(runner, 'data/audit/owe-promotion-log.jsonl', '{"promoted":"goblin-2026"}\n');
  git(runner, 'add', '-A');
  git(runner, 'commit', '-q', '-m', 'data: OWE venue-page promotion audit log [skip ci]');

  // Meanwhile another workflow lands an unrelated commit on main.
  write(seed, 'other.txt', 'v1\n');
  git(seed, 'commit', '-q', '-am', 'unrelated concurrent push');
  git(seed, 'push', '-q', origin, 'main');

  const r = push(runner, tmp);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `push-with-retry failed:\n${out.slice(-3000)}`);
  assert.doesNotMatch(out, /REVERTED/);
  assert.deepEqual(remoteRows(origin), [flush], 'the pruned row stays pruned on origin');
  assert.equal(execFileSync('git', ['--git-dir', origin, 'show', 'main:other.txt'], { encoding: 'utf8' }), 'v1\n');
});

test('concurrent staging adds still survive the prune (BRO-4268 lost update stays fixed), including one the -X theirs rebase swallowed', (t) => {
  const goblin = row('Goblin');
  const flush = row('Flush');
  const { tmp, origin, seed, runner } = setup(t, [goblin, flush]);

  write(runner, FILE, [flush]);
  git(runner, 'commit', '-q', '-am', 'prune Goblin');

  // Discovery stages a new row in the same hunk the prune touched, so the
  // rebase's textual merge conflicts and -X theirs keeps OUR side only.
  const ghost = row('A Ghost in Your Ear', { venue: 'Hampstead Theatre Downstairs' });
  write(seed, FILE, [ghost, goblin, flush]);
  git(seed, 'commit', '-q', '-am', 'discovery stages a row');
  git(seed, 'push', '-q', origin, 'main');

  const r = push(runner, tmp);
  assert.equal(r.status, 0, `push-with-retry failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
  const final = remoteRows(origin);
  assert.ok(final.some((c) => c.title === 'A Ghost in Your Ear'), 'the concurrently staged row is kept');
  assert.ok(!final.some((c) => c.title === 'Goblin'), 'the promoter prune holds');
  assert.equal(final.length, 2);
});

// readBase() (reconcile-merged-json.js) after a rebase: HEAD sits on origin's
// tip, so `merge-base HEAD origin` IS origin. PUSH_RECONCILE_BASE carries the
// pre-rebase fork point; without it a requiresTrueBase merger gets no base.
test('readBase: env base wins; no/invalid env base -> undefined for requiresTrueBase, legacy merge-base otherwise', (t) => {
  const require = createRequire(import.meta.url);
  const { origin, seed, runner } = setup(t, [row('A')]);
  const X = git(runner, 'rev-parse', 'HEAD');
  write(seed, FILE, [row('A'), row('B')]);
  git(seed, 'commit', '-q', '-am', 'remote adds B');
  git(seed, 'push', '-q', origin, 'main');
  git(runner, 'fetch', '-q', 'origin', 'main');
  git(runner, 'reset', '-q', '--hard', 'origin/main'); // stand-in for "rebased onto origin"
  write(runner, FILE, []);

  const prevCwd = process.cwd();
  const prevEnv = process.env.PUSH_RECONCILE_BASE;
  t.after(() => { process.chdir(prevCwd); if (prevEnv === undefined) delete process.env.PUSH_RECONCILE_BASE; else process.env.PUSH_RECONCILE_BASE = prevEnv; });
  process.chdir(runner);
  const { readBase } = require('./reconcile-merged-json.js');
  const titles = (rows) => (rows || []).map((r) => r.title);

  process.env.PUSH_RECONCILE_BASE = X;
  assert.deepEqual(titles(readBase('origin/main', FILE, 'json', { requiresTrueBase: true })), ['A'], 'the fork point, not origin');
  for (const bad of ['', 'not-a-sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']) {
    process.env.PUSH_RECONCILE_BASE = bad;
    assert.equal(readBase('origin/main', FILE, 'json', { requiresTrueBase: true }), undefined, `env=${JSON.stringify(bad)} -> two-way`);
    assert.deepEqual(titles(readBase('origin/main', FILE, 'json')), ['A', 'B'], 'other mergers keep the legacy merge-base (== origin here)');
  }
  delete process.env.PUSH_RECONCILE_BASE;
  assert.equal(readBase('origin/main', FILE, 'json', { requiresTrueBase: true }), undefined);
});
