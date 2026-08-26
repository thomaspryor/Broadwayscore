import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isShallowClone, ensureFullHistory, countPriorMergesInHistory } = require('./check-merge-history.js');

// Fake git: a script of {args, cwd} -> string|throw, matched by joining args.
function fakeGit(script) {
  const calls = [];
  const gitFn = (args, cwd) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    const entry = script[key];
    if (entry === undefined) throw new Error(`fakeGit: no script entry for "${key}"`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  gitFn.calls = calls;
  return gitFn;
}

test('isShallowClone: true when rev-parse reports true', () => {
  const gitFn = fakeGit({ 'rev-parse --is-shallow-repository': 'true\n' });
  assert.equal(isShallowClone('/repo', gitFn), true);
});

test('isShallowClone: false on a full-history clone (incl. blobless)', () => {
  const gitFn = fakeGit({ 'rev-parse --is-shallow-repository': 'false\n' });
  assert.equal(isShallowClone('/repo', gitFn), false);
});

test('isShallowClone: treats a failed rev-parse as shallow (safe default)', () => {
  const gitFn = fakeGit({});
  assert.equal(isShallowClone('/repo', gitFn), true);
});

test('ensureFullHistory: no-op, no fetch, when already full', () => {
  const gitFn = fakeGit({ 'rev-parse --is-shallow-repository': 'false\n' });
  const result = ensureFullHistory('/repo', { gitFn });
  assert.equal(result.deepened, false);
  assert.equal(gitFn.calls.length, 1, 'must not fetch when not shallow');
});

test('ensureFullHistory: deepens via fetch --unshallow when shallow', () => {
  const gitFn = fakeGit({
    'rev-parse --is-shallow-repository': 'true\n',
    'fetch --unshallow origin': '',
  });
  const logs = [];
  const result = ensureFullHistory('/repo', { gitFn, log: (m) => logs.push(m) });
  assert.equal(result.deepened, true);
  assert.ok(gitFn.calls.some((c) => c.args.join(' ') === 'fetch --unshallow origin'));
  assert.ok(logs.some((m) => m.includes('deepening to full history')));
});

test('ensureFullHistory: swallows a failed deepen (best-effort, never throws)', () => {
  const gitFn = fakeGit({
    'rev-parse --is-shallow-repository': 'true\n',
    'fetch --unshallow origin': new Error('network unreachable'),
  });
  const logs = [];
  const result = ensureFullHistory('/repo', { gitFn, log: (m) => logs.push(m) });
  assert.equal(result.deepened, false);
  assert.ok(result.error);
  assert.ok(logs.some((m) => m.includes('WARN')));
});

test('countPriorMergesInHistory: counts matching trailer commits on a full clone', () => {
  const gitFn = fakeGit({
    'rev-parse --is-shallow-repository': 'false\n',
    "log --fixed-strings --grep Auto-merge-card: BRO-1 --format=%H origin/main": 'aaa\nbbb\n',
  });
  const n = countPriorMergesInHistory('Auto-merge-card: BRO-1', 'origin/main', '/repo', { gitFn });
  assert.equal(n, 2);
});

test('countPriorMergesInHistory: 0 when no commits match', () => {
  const gitFn = fakeGit({
    'rev-parse --is-shallow-repository': 'false\n',
    "log --fixed-strings --grep Auto-merge-card: BRO-1 --format=%H origin/main": '',
  });
  const n = countPriorMergesInHistory('Auto-merge-card: BRO-1', 'origin/main', '/repo', { gitFn });
  assert.equal(n, 0);
});

test('countPriorMergesInHistory: deepens a shallow clone before counting (regression guard)', () => {
  // This is the case BRO-423 exists to prevent: if a workflow edit ever
  // reintroduces a shallow checkout, the oscillation scan must not silently
  // undercount — it must deepen first so the "2+ prior merges" hard stop
  // still fires reliably.
  const gitFn = fakeGit({
    'rev-parse --is-shallow-repository': 'true\n',
    'fetch --unshallow origin': '',
    "log --fixed-strings --grep Auto-merge-card: BRO-1 --format=%H origin/main": 'aaa\nbbb\nccc\n',
  });
  const n = countPriorMergesInHistory('Auto-merge-card: BRO-1', 'origin/main', '/repo', { gitFn });
  assert.equal(n, 3);
  assert.ok(gitFn.calls.some((c) => c.args.join(' ') === 'fetch --unshallow origin'));
});

test('countPriorMergesInHistory: returns 0 (never throws) when the log call itself fails', () => {
  const gitFn = fakeGit({
    'rev-parse --is-shallow-repository': 'false\n',
    "log --fixed-strings --grep Auto-merge-card: BRO-1 --format=%H origin/main": new Error('unknown revision'),
  });
  const n = countPriorMergesInHistory('Auto-merge-card: BRO-1', 'origin/main', '/repo', { gitFn });
  assert.equal(n, 0);
});
