/**
 * Integration tests for the push-retry-failure telemetry mechanism (task:
 * push-retry-failure telemetry, 2026-08-23, Notion
 * 3c5637c5-416f-81c3-8bbb-d574d991a841 Phase 0, /plan-review'd — six
 * independent reviewers).
 *
 * Reuses tests/unit/push-ledger-store.test.mjs's real-bare-repo fixture
 * pattern — this store's contract is git plumbing + CAS push semantics, a
 * mocked git would test nothing.
 *
 * Invariants under test:
 *  1. The generalized store (branch/file params) works for a SECOND,
 *     independent branch — not just the original push-ledger defaults.
 *  2. Writes land on `push-retry-failures`, NEVER on main or `push-ledger`.
 *  3. record-push-retry-failure.js end-to-end: records an entry, exits 0,
 *     respects its OWN kill switch (PUSH_SKIP_FAILURE_LEDGER, separate from
 *     PUSH_SKIP_LEDGER) and the canonical-repo gate.
 *  4. CONCURRENT-WRITER STRESS TEST (restructured validation ramp —
 *     plan-review finding: the original ramp proved only a single writer
 *     round-trips; failures are CORRELATED, unlike the push-ledger success
 *     stream's naturally-staggered writes, so the real risk condition is N
 *     writers racing the same CAS lease simultaneously during a contention
 *     burst — exactly when this telemetry matters most). Asserts every
 *     concurrent writer's entry survives (via retry-on-lease-rejection, not
 *     silent loss) and the branch still converges to exactly ONE commit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const { readLedger, writeLedger } = require('../../scripts/lib/push-ledger-store.js');
const { buildFailureEntry, parseLedgerLines } = require('../../scripts/lib/push-ledger.js');
const { FAILURE_BRANCH, FAILURE_FILE } = require('../../scripts/record-push-retry-failure.js');
const RECORD_SCRIPT = path.resolve(fileURLToPath(new URL('../../scripts/record-push-retry-failure.js', import.meta.url)));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  PUSH_LEDGER_ANY_ORIGIN: '1',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-failure-ledger-'));
  const originDir = path.join(tmp, 'origin.git');
  const cloneDir = path.join(tmp, 'clone');
  sh(`git init -q --bare "${originDir}"`, tmp);
  sh(`git init -q "${cloneDir}"`, tmp);
  sh('git config user.email t@t.t', cloneDir);
  sh('git config user.name t', cloneDir);
  sh('git commit -q --allow-empty -m base', cloneDir);
  sh('git branch -M main', cloneDir);
  sh(`git remote add origin "${originDir}"`, cloneDir);
  sh('git push -q origin main', cloneDir);
  return { tmp, originDir, cloneDir };
}

function branchCommitCount(originDir, branch) {
  return sh(`git --git-dir="${originDir}" rev-list --count ${branch}`).trim();
}

function branchExists(originDir, branch) {
  try {
    sh(`git --git-dir="${originDir}" rev-parse ${branch}`);
    return true;
  } catch {
    return false;
  }
}

test('generalized store: a second branch/file pair works independently of push-ledger defaults', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    const opts = { branch: FAILURE_BRANCH, file: FAILURE_FILE };
    const first = readLedger(cloneDir, opts);
    assert.equal(first.tip, '');
    writeLedger(cloneDir, 'entry-one\n', first.tip, opts);

    const second = readLedger(cloneDir, opts);
    assert.equal(second.content, 'entry-one\n');
    writeLedger(cloneDir, second.content + 'entry-two\n', second.tip, opts);

    assert.equal(branchCommitCount(originDir, FAILURE_BRANCH), '1',
      'push-retry-failures branch must stay a single root commit');
    assert.equal(branchExists(originDir, 'push-ledger'), false,
      'the generalized store must not touch the unrelated push-ledger branch');
    assert.equal(branchCommitCount(originDir, 'main'), '1',
      'push-retry-failures writes must never add commits to main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildFailureEntry + parseLedgerLines round-trip (no sha field required)', () => {
  const line = buildFailureEntry({
    reason: 'retries-exhausted', attempt: 25, maxRetries: 25,
    branch: 'main', remote: 'Broadwayscore', workflow: 'Daily Data Health Check', ci: true,
  });
  const [entry] = parseLedgerLines(line, ['reason', 'ts']);
  assert.equal(entry.reason, 'retries-exhausted');
  assert.equal(entry.attempt, 25);
  assert.equal(entry.ci, true);

  // A push-success-shaped entry (has sha, no reason) must NOT satisfy the
  // failure-ledger's required-field set, and vice versa — confirms the
  // shared parser genuinely discriminates by requiredFields, not just by
  // being valid JSON.
  const successLine = JSON.stringify({ sha: 'abc123', ts: new Date().toISOString() });
  assert.equal(parseLedgerLines(successLine, ['reason', 'ts']).length, 0,
    'a success-shaped entry must not parse as a failure entry');
});

test('record-push-retry-failure.js end-to-end: entry recorded on push-retry-failures branch, exit 0', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    const out = execFileSync('node', [RECORD_SCRIPT, '--reason=noop-rebase(unknown)', '--attempt=3', '--max-retries=7', '--branch=main', '--remote=Broadwayscore'], {
      cwd: cloneDir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV },
    });
    assert.match(out, /recorded "noop-rebase\(unknown\)"/);

    const content = sh(`git --git-dir="${originDir}" show ${FAILURE_BRANCH}:${FAILURE_FILE}`);
    const entry = JSON.parse(content.trim());
    assert.equal(entry.reason, 'noop-rebase(unknown)');
    assert.equal(entry.attempt, 3);
    assert.equal(branchCommitCount(originDir, 'main'), '1',
      'record-push-retry-failure must not commit to main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('record-push-retry-failure.js has its OWN kill switch, separate from PUSH_SKIP_LEDGER', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    // PUSH_SKIP_LEDGER (the success-ledger's switch) must NOT disable this
    // recorder — the two telemetry streams are independently killable.
    execFileSync('node', [RECORD_SCRIPT, '--reason=x', '--branch=main'], {
      cwd: cloneDir, encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PUSH_SKIP_LEDGER: '1' },
    });
    assert.equal(branchExists(originDir, FAILURE_BRANCH), true,
      'PUSH_SKIP_LEDGER must not silently blind the failure ledger too');

    // Its own switch does disable it.
    const { tmp: tmp2, originDir: originDir2, cloneDir: cloneDir2 } = makeFixture();
    execFileSync('node', [RECORD_SCRIPT, '--reason=x', '--branch=main'], {
      cwd: cloneDir2, encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PUSH_SKIP_FAILURE_LEDGER: '1' },
    });
    assert.equal(branchExists(originDir2, FAILURE_BRANCH), false,
      'PUSH_SKIP_FAILURE_LEDGER must disable this recorder');
    fs.rmSync(tmp2, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('record-push-retry-failure.js canonical-repo gate: non-Broadwayscore origins are NOT ledgered without the override', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    const env = { ...process.env, ...GIT_ENV };
    delete env.PUSH_LEDGER_ANY_ORIGIN;
    const out = execFileSync('node', [RECORD_SCRIPT, '--reason=x', '--branch=main'], {
      cwd: cloneDir, encoding: 'utf8', env,
    });
    assert.match(out, /skipping — cwd origin .* is not the canonical Broadwayscore repo/);
    assert.equal(branchExists(originDir, FAILURE_BRANCH), false,
      'no failure-ledger branch may be created on a non-canonical origin');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CONCURRENT-WRITER STRESS: N racing writers all survive via CAS retry, branch stays single-commit', async () => {
  // The restructured validation ramp (plan-review finding, three independent
  // reviewers): failures are CORRELATED — many of ~153 workflows can hit
  // record_push_failure() in the same narrow window during a real
  // contention burst, all racing the SAME push-retry-failures CAS lease
  // simultaneously. A single-writer round-trip proves the mechanism works;
  // it does not prove entries survive concurrent load. This test simulates
  // 10 concurrent writers (each its own process, own retry loop — same code
  // path record-push-retry-failure.js actually runs in CI) and asserts every
  // one's entry is present afterward, not silently dropped by a lost lease.
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    const WRITER_COUNT = 10;
    // execFile (async, non-blocking) — NOT execFileSync. A sync call inside
    // a Promise executor still runs to completion before the next array
    // element's executor even starts (the executor body itself is
    // synchronous), which would make every "concurrent" writer actually run
    // serially and prove nothing about CAS-lease contention. execFile
    // spawns the child process and returns control immediately, so all
    // WRITER_COUNT processes are genuinely running in parallel once
    // Promise.all below fires them all in the same synchronous pass.
    // timeout: 15000 matches push-with-retry.sh's actual `_timeout 15` outer
    // cap exactly (ship-check finding: an earlier version of this test used
    // 30000ms here, which validated the CLI's retry logic under a MORE
    // GENEROUS window than the real production caller ever grants — a false
    // sense of safety, since the thing that matters is "does this survive
    // contention within the budget push-with-retry.sh actually gives it,"
    // not "does it eventually succeed with no time limit."
    const writers = Array.from({ length: WRITER_COUNT }, (_, i) =>
      execFileAsync('node', [RECORD_SCRIPT, `--reason=concurrent-writer-${i}`, '--branch=main'], {
        cwd: cloneDir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, timeout: 15000,
      })
    );
    await Promise.all(writers);

    const content = sh(`git --git-dir="${originDir}" show ${FAILURE_BRANCH}:${FAILURE_FILE}`);
    const entries = parseLedgerLines(content, ['reason', 'ts']);
    const reasons = new Set(entries.map((e) => e.reason));
    for (let i = 0; i < WRITER_COUNT; i++) {
      assert.ok(reasons.has(`concurrent-writer-${i}`),
        `writer ${i}'s entry must survive concurrent CAS contention, not be silently dropped`);
    }
    assert.equal(entries.length, WRITER_COUNT,
      'no entry should be duplicated or lost under concurrent writes');
    assert.equal(branchCommitCount(originDir, FAILURE_BRANCH), '1',
      'the branch must still converge to exactly one commit after concurrent writes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
