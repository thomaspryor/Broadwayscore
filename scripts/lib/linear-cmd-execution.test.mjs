/**
 * linear-cmd-execution.test.mjs — makeVerifyCmdEvidence(), the real I/O
 * built for linear-done-gate.js's execution check (BRO-3885).
 *
 * Uses a LOCAL bare "origin" + working checkout (same pattern
 * tests/unit/done-evidence-verify.test.mjs's makeRepo() uses) so
 * makeFreshCheckout's `git fetch origin main` / `git worktree add` run for
 * real against a local remote — no network, no dependency on this repo's
 * own origin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { makeVerifyCmdEvidence } = require(path.join(REPO, 'scripts/lib/linear-cmd-execution.js'));
const { VERDICTS } = require(path.join(REPO, 'scripts/lib/close-time-verify.js'));

// withNodeModules: acceptance-check-core.js's makeFreshCheckout only links
// node_modules if the repo it's pointed at HAS one (prepareCheckWorkdir
// symlinks repoRoot/node_modules into the fresh checkout) — without it,
// runVerify reports EVERY command 'unverifiable' before ever looking at the
// command itself ("checkout has no node_modules"), which would make tests 1-3
// below indistinguishable from the dedicated unverifiable test at the bottom.
// An EMPTY node_modules dir is enough to satisfy the existence check.
function makeRepo({ withNodeModules = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-cmd-execution-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', origin);
  if (withNodeModules) fs.mkdirSync(path.join(work, 'node_modules'));
  return { root, work, git };
}

test('makeVerifyCmdEvidence: a real PASSING command on origin/main is allowed', (t) => {
  const { root, work, git } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  fs.mkdirSync(path.join(work, 'tests/unit'), { recursive: true });
  fs.writeFileSync(path.join(work, 'tests/unit/ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'add passing test');
  git('push', '-q', 'origin', 'main');

  const verifyCmdEvidence = makeVerifyCmdEvidence({ repo: work, log: () => {} });
  const result = verifyCmdEvidence('node --test tests/unit/ok.test.mjs');
  assert.equal(result.allowed, true);
  assert.equal(result.verdict, VERDICTS.PASS);
  assert.ok(result.sha, 'reports the origin/main sha it checked out');
});

test('makeVerifyCmdEvidence: a real FAILING command on origin/main is refused', (t) => {
  const { root, work, git } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  fs.mkdirSync(path.join(work, 'tests/unit'), { recursive: true });
  fs.writeFileSync(
    path.join(work, 'tests/unit/broken.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => { assert.equal(1, 2); });\n",
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'add failing test');
  git('push', '-q', 'origin', 'main');

  const verifyCmdEvidence = makeVerifyCmdEvidence({ repo: work, log: () => {} });
  const result = verifyCmdEvidence('node --test tests/unit/broken.test.mjs');
  assert.equal(result.allowed, false);
  assert.equal(result.verdict, VERDICTS.FAIL);
});

test('makeVerifyCmdEvidence: a command naming a path absent from origin/main is refused, not trusted', (t) => {
  const { root, work, git } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('push', '-q', 'origin', 'main');

  const verifyCmdEvidence = makeVerifyCmdEvidence({ repo: work, log: () => {} });
  const result = verifyCmdEvidence('node --test tests/unit/never-created.test.mjs');
  assert.equal(result.allowed, false);
  assert.equal(result.notOnMain, true);
});

// Codex adversarial finding (ship-check, BRO-3885): decideClose's own message
// for its 'unverifiable' verdict says "closing without a verdict" because
// close-time-verify.js fails OPEN there — this caller does not (a claimed
// command that could not even run is not done-evidence here). Reusing that
// message verbatim would tell an operator their refused close is proceeding.
// This checkout has no node_modules anywhere reachable (it is a throwaway
// bare repo, not this project), so runVerify reports 'unverifiable' for real.
test('makeVerifyCmdEvidence: an UNVERIFIABLE result is refused with a message that does not say "closing"', (t) => {
  const { root, work, git } = makeRepo({ withNodeModules: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  fs.mkdirSync(path.join(work, 'tests/unit'), { recursive: true });
  fs.writeFileSync(path.join(work, 'tests/unit/ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('push', '-q', 'origin', 'main');

  const verifyCmdEvidence = makeVerifyCmdEvidence({ repo: work, log: () => {} });
  const result = verifyCmdEvidence('node --test tests/unit/ok.test.mjs');
  assert.equal(result.allowed, false);
  assert.equal(result.verdict, VERDICTS.UNVERIFIABLE);
  assert.doesNotMatch(result.reason, /closing/i, 'the refusal reason must not claim it is closing anyway');
  assert.match(result.reason, /not confirmed to pass/i);
  assert.match(result.reason, /node_modules/);
});
