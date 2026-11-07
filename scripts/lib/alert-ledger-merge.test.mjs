// BRO-5363: exercise the actual push replay, including the unconditional
// reconciliation added by BRO-5204. A clean -X theirs rebase alone loses
// the other writer's appended conditions without reporting a conflict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUSH = fileURLToPath(new URL('./push-with-retry.sh', import.meta.url));
const LEDGER = 'data/audit/alert-ledger.json';
const QUEUE = 'data/audit/alert-digest-queue.json';
// Never inherit a hook's repository/index or a caller's push flags. All
// remotes and telemetry below belong to disposable local repositories.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|PUSH_|GITHUB_|CI$)/.test(k))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
}).trim();
const write = (cwd, file, value) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), JSON.stringify(value, null, 2) + '\n');
};
const read = (cwd, file) => JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'));
const condition = (title) => ({
  status: 'open', disposition: 'auto', title,
  firstSeen: '2026-10-12T22:35:00Z', lastSeen: '2026-10-12T22:35:00Z',
  lastNotifiedAt: '2026-10-12T22:35:00Z', notifyCount: 1,
});
const seed = condition('Existing condition');
const ours = condition('Landing alert');
const theirs = condition('Time-bomb alert');
const ledger = (conditions) => ({ conditions });
const digest = (conditionKey) => ({ conditionKey, title: conditionKey, queuedAt: '2026-10-12T22:35:00Z' });

function race(t, file, base, local, remote) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5363-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const origin = path.join(tmp, 'origin.git');
  const writer = path.join(tmp, 'writer');
  const runner = path.join(tmp, 'runner');
  git(tmp, 'init', '-q', '--bare', origin);
  // Avoid receive-pack spawning detached maintenance during cleanup.
  for (const [key, value] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) {
    git(origin, 'config', key, value);
  }
  git(tmp, 'init', '-q', '-b', 'main', writer);
  write(writer, file, base);
  git(writer, 'add', file);
  git(writer, 'commit', '-qm', 'base');
  git(writer, 'remote', 'add', 'origin', origin);
  git(writer, 'push', '-q', 'origin', 'main');
  git(tmp, 'clone', '-q', '-b', 'main', origin, runner);

  write(runner, file, local);
  git(runner, 'commit', '-qam', 'later writer from stale checkout');
  const localCommit = git(runner, 'rev-parse', 'HEAD');
  write(writer, file, remote);
  git(writer, 'commit', '-qam', 'concurrent alert conditions');
  const remoteCommit = git(writer, 'rev-parse', 'HEAD');
  git(writer, 'push', '-q', 'origin', 'main');

  // Establish the real failure precondition, then restore the stale writer
  // so push-with-retry must handle the non-fast-forward rejection itself.
  git(runner, 'fetch', '-q', 'origin', 'main');
  git(runner, 'rebase', '-X', 'theirs', 'origin/main');
  assert.deepEqual(read(runner, file), local, 'plain replay must lose the remote append');
  git(runner, 'reset', '-q', '--hard', localCommit);

  const result = spawnSync('bash', [PUSH, '3', 'main'], {
    cwd: runner, encoding: 'utf8', timeout: 120_000,
    env: {
      ...ENV, PUSH_RECONCILE_MERGED_JSON: '0', PUSH_SKIP_LEDGER: '1',
      PUSH_SKIP_FAILURE_LEDGER: '1', PUSH_API_FALLBACK_DISABLE: '1', PUSH_DEADLINE_SEC: '90',
      PUSH_FAILURE_LOG: path.join(tmp, 'push-failures.jsonl'),
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `push failed (${result.error || ''}):\n${output}`);
  assert.match(output, /reconciled /, 'the unconditional reconciliation must run');
  assert.ok(output.includes(`reconciled ${file} against origin/main`), output);
  assert.doesNotMatch(output, /Trying merge|Trying reset|Rebase failed/, 'no fallback should replace the clean replay');
  assert.match(output, /Push succeeded after conflict resolution \(attempt 1\)/, 'reject, replay, then push');
  assert.equal(git(runner, 'rev-parse', 'HEAD^'), remoteCommit, 'the replayed commit sits directly on the remote writer');
  assert.equal(git(runner, 'status', '--porcelain'), '', 'reconciliation is committed');
  const pushed = JSON.parse(git(origin, 'show', `main:${file}`));
  assert.deepEqual(read(runner, file), pushed, 'check the pushed tree, not just the working copy');
  return pushed;
}

test('two commits adding disjoint alert conditions both survive push-with-retry replay', (t) => {
  const local = ledger({ seed, 'land:gate-red': ours });
  const remote = ledger({ seed, 'time-bomb-tests:unit:regression': theirs });
  assert.deepEqual(race(t, LEDGER, ledger({ seed }), local, remote), ledger({
    seed, 'land:gate-red': ours, 'time-bomb-tests:unit:regression': theirs,
  }));
});

test('replay restores concurrent ledger additions without resurrecting a deleted synthetic condition', (t) => {
  const base = ledger({ 'e2e:synthetic': condition('Synthetic canary'), seed });
  const local = ledger({ seed, 'land:gate-red': ours });
  const remote = ledger({ ...base.conditions, 'time-bomb-tests:unit:regression': theirs });
  assert.deepEqual(race(t, LEDGER, base, local, remote), ledger({
    seed, 'land:gate-red': ours, 'time-bomb-tests:unit:regression': theirs,
  }));
});

test('replay keeps both digest additions without resurrecting an already drained row', (t) => {
  const drained = digest('delivered:condition');
  const kept = digest('still-queued:condition');
  const local = [kept, digest('land:gate-red')];
  const remote = [drained, kept, digest('time-bomb-tests:unit:regression')];
  assert.deepEqual(race(t, QUEUE, [drained, kept], local, remote), [...local, remote[2]]);
});
