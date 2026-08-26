import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncMemoryPull } = require('./memory-sync-pull.js');

// Fake git runner: a scripted queue of responses keyed by "<subcommand>
// <next-arg>" (args[2] + args[3], since args[0]/args[1] are always '-C',
// repo) — distinguishes `merge --no-edit …` from `merge --abort`, which
// share args[2]='merge'. Falls back to just args[2] for single-form
// commands like `fetch`. Records every invocation for assertions.
function fakeGit(script) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const key = `${args[2]} ${args[3] || ''}`.trim();
    const response = script[key] || script[args[2]];
    if (!response) throw new Error(`fakeGit: no scripted response for '${key}' (${args.join(' ')})`);
    return response;
  };
  git.calls = calls;
  return git;
}

test('clean pull path returns ok and issues no abort', () => {
  const errors = [];
  const git = fakeGit({
    fetch: { status: 0, stdout: '', stderr: '' },
    merge: { status: 0, stdout: '', stderr: '' },
  });
  const outcome = syncMemoryPull({ repo: '/repo', git, logError: (l) => errors.push(l) });

  assert.equal(outcome.result, 'ok');
  assert.equal(outcome.abortIssued, false);
  assert.deepEqual(git.calls.map((c) => c[2]), ['fetch', 'merge']);
  assert.ok(!git.calls.some((c) => c.includes('abort')), 'no abort issued on a clean merge');
  assert.equal(errors.length, 0);
});

test('conflicting replay returns aborted and issues the abort call', () => {
  const errors = [];
  const git = fakeGit({
    fetch: { status: 0, stdout: '', stderr: '' },
    'merge --no-edit': { status: 1, stdout: '', stderr: 'CONFLICT (add/add): Merge conflict in scripts/express-retry-queue.js' },
    'merge --abort': { status: 0, stdout: '', stderr: '' },
  });
  const outcome = syncMemoryPull({ repo: '/repo', git, logError: (l) => errors.push(l) });

  assert.equal(outcome.result, 'aborted');
  assert.equal(outcome.abortIssued, true);
  const commands = git.calls.map((c) => `${c[2]} ${c[3] || ''}`.trim());
  assert.ok(commands.includes('merge --no-edit'), 'attempted the merge');
  assert.ok(git.calls.some((c) => c[2] === 'merge' && c[3] === '--abort'), 'issued merge --abort');
});

test('a stray in-progress rebase falls back to rebase --abort when merge --abort fails', () => {
  const git = (args) => {
    const cmd = args[2];
    if (cmd === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'merge' && args[3] !== '--abort') return { status: 1, stdout: '', stderr: 'conflict' };
    if (cmd === 'merge' && args[3] === '--abort') return { status: 1, stdout: '', stderr: 'no merge to abort' };
    if (cmd === 'rebase' && args[3] === '--abort') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const outcome = syncMemoryPull({ repo: '/repo', git });

  assert.equal(outcome.result, 'aborted');
  assert.equal(outcome.abortIssued, true);
});

test('failure is surfaced via logError rather than swallowed', () => {
  const errors = [];
  const git = fakeGit({
    fetch: { status: 0, stdout: '', stderr: '' },
    'merge --no-edit': { status: 1, stdout: '', stderr: 'CONFLICT (add/add): Merge conflict in scripts/express-retry-queue.js' },
    'merge --abort': { status: 0, stdout: '', stderr: '' },
  });
  syncMemoryPull({ repo: '/repo', git, logError: (l) => errors.push(l) });

  assert.ok(errors.length > 0, 'at least one error line was logged');
  assert.ok(errors.some((l) => l.includes('CONFLICT')), 'the underlying git stderr reaches the log, not just a generic message');
});

test('fetch failure is skipped (never attempts a merge) and surfaces on stderr', () => {
  const errors = [];
  const git = fakeGit({
    fetch: { status: 1, stdout: '', stderr: 'could not resolve host' },
  });
  const outcome = syncMemoryPull({ repo: '/repo', git, logError: (l) => errors.push(l) });

  assert.equal(outcome.result, 'skipped');
  assert.equal(outcome.abortIssued, false);
  assert.equal(git.calls.length, 1);
  assert.ok(errors.some((l) => l.includes('could not resolve host')));
});

test('throws when required args are missing', () => {
  assert.throws(() => syncMemoryPull({ repo: '/repo' }));
  assert.throws(() => syncMemoryPull({ git: () => ({ status: 0, stdout: '', stderr: '' }) }));
});
