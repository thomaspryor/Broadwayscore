import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkLinearDoneTransition, recordedCheckCloseCheck, CHECK_ON_MAIN_BLOCKING_FROM } = require('./linear-done-gate.js');
const { makePathsOnMain } = require('./linear-cmd-execution.js');

const BEFORE = Date.parse('2026-11-18T00:00:00Z');
const AFTER = Date.parse(`${CHECK_ON_MAIN_BLOCKING_FROM}T00:00:00Z`) + 86400000;
const prClose = (cmd, extra = {}) => ({
  targetStateType: 'completed',
  description: `Work.\n\n## Acceptance criteria\nVERIFY: ${cmd}\n`,
  commentText: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/abcdef1234567)',
  verifyEvidence: () => ({ verified: true, reason: 'on main' }),
  verifyCmdEvidence: () => { throw new Error('the PR-EVIDENCE route must not run the command'); },
  identifier: 'BRO-1', title: 'x', landedFiles: [], recurrenceSnapshot: null,
  ...extra,
});

// Real ledger commands: BRO-6962 and BRO-6961 closed on checks that never reached main; the third file exists.
const NEVER_LANDED = ['node --test tests/unit/search-parity.test.mjs', 'node --test tests/unit/browse-sort-parity.test.mjs'];
const EXISTS = 'node --test scripts/lib/recheck-route.test.mjs';

test('makePathsOnMain on the real repo: never-landed tests are missing, an existing test is not', () => {
  const p = makePathsOnMain();
  for (const cmd of NEVER_LANDED) assert.equal(p(cmd).missing.length, 1, cmd);
  assert.deepEqual(p(EXISTS).missing, []);
  assert.deepEqual(p('echo hi').missing, [], 'not a safe-form check: nothing to look up');
  assert.deepEqual(makePathsOnMain({ ref: 'origin/no-such-ref' })(NEVER_LANDED[0]).missing, [], 'fails open when the ref is unreadable');
});

test('advisory before the date: allowed with a warning that names the missing test', () => {
  const pathsOnMain = makePathsOnMain();
  for (const cmd of NEVER_LANDED) {
    const r = checkLinearDoneTransition(prClose(cmd, { pathsOnMain, nowMs: BEFORE }));
    assert.equal(r.allowed, true, cmd);
    assert.match(r.warning, /not on origin\/main/);
    assert.match(r.warning, /Advisory now/);
  }
});

test('blocking from the date: the same close is refused; rollback env keeps it advisory', () => {
  const pathsOnMain = makePathsOnMain();
  const r = checkLinearDoneTransition(prClose(NEVER_LANDED[0], { pathsOnMain, nowMs: AFTER }));
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, 'recorded-check-not-on-main');
  const cc = recordedCheckCloseCheck({ ...prClose(NEVER_LANDED[0]), pathsOnMain, nowMs: AFTER, env: { CLOSE_CHECK_ON_MAIN_GATE: 'advisory' } });
  assert.equal(cc.blocking, false);
});

test('a close whose recorded check exists on main is untouched; no verifier wired means no finding', () => {
  const ok = checkLinearDoneTransition(prClose(EXISTS, { pathsOnMain: makePathsOnMain(), nowMs: AFTER }));
  assert.equal(ok.allowed, true);
  assert.ok(!ok.warning || !/not on origin\/main/.test(ok.warning));
  const none = checkLinearDoneTransition(prClose(NEVER_LANDED[0], { nowMs: AFTER }));
  assert.equal(none.allowed, true, 'existing callers that pass no pathsOnMain behave exactly as before');
});

// BRO-7789 cousin: makePathsOnMain's fetch ran `--depth=1 origin main` in the
// main checkout. In a full (or deeper) clone that grafts the new origin/main
// tip as a parentless root, so HEAD and origin/main share no history and every
// later fast-forward fails ("refusing to merge unrelated histories").
test('makePathsOnMain fetch keeps a full clone full and origin/main connected to HEAD', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-on-main-'));
  try {
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    g(seed, 'init', '-q', '-b', 'main');
    g(seed, 'config', 'user.email', 't@t'); g(seed, 'config', 'user.name', 't');
    const commit = (n) => { fs.writeFileSync(path.join(seed, `f${n}.txt`), String(n)); g(seed, 'add', '.'); g(seed, 'commit', '-q', '-m', `c${n}`); };
    commit(1); commit(2);
    const clone = path.join(root, 'clone');
    g(root, 'clone', '-q', `file://${seed}`, clone);
    commit(3); commit(4);
    assert.deepEqual(makePathsOnMain({ repo: clone })('test -f f4.txt').missing, [], 'the fetched origin/main has the new file');
    assert.equal(g(clone, 'rev-parse', '--is-shallow-repository'), 'false', 'the fetch must not shallow a full clone');
    g(clone, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'); // throws when the histories are disconnected
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
