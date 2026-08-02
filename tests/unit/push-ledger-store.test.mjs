/**
 * Integration tests for scripts/lib/push-ledger-store.js and the rewritten
 * scripts/record-push-ledger.js (2026-08-02 commit-churn fix, Notion
 * 3b0637c5). Uses a real local bare repo as `origin` — the store's whole
 * contract is git plumbing + CAS push semantics, so a mocked git would test
 * nothing.
 *
 * Invariants under test:
 *  1. Writes land on the dedicated `push-ledger` branch, NEVER on main.
 *  2. The branch is always exactly ONE root commit (replaced per write).
 *  3. Appends accumulate entries across writes (read → append → CAS write).
 *  4. A stale expected-tip write is REJECTED (compare-and-swap holds).
 *  5. record-push-ledger.js end-to-end: records an entry against the
 *     invoking repo's origin, leaves main untouched, exits 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readLedger, writeLedger, LEDGER_BRANCH, LEDGER_FILE } = require('../../scripts/lib/push-ledger-store.js');
const RECORD_SCRIPT = path.resolve(fileURLToPath(new URL('../../scripts/record-push-ledger.js', import.meta.url)));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  // Fixture origins are bare temp paths, not the canonical Broadwayscore
  // repo — opt out of record-push-ledger.js's canonical-repo gate so the
  // real recording path runs against the fixture.
  PUSH_LEDGER_ANY_ORIGIN: '1',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-ledger-store-'));
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

function originBranchCommitCount(originDir, branch) {
  return sh(`git --git-dir="${originDir}" rev-list --count ${branch}`).trim();
}

test('store: create, append, single-commit branch, main untouched', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    // First-ever write: branch absent, expected tip empty.
    const first = readLedger(cloneDir);
    assert.equal(first.tip, '');
    assert.equal(first.content, '');
    writeLedger(cloneDir, 'line-one\n', first.tip);

    const second = readLedger(cloneDir);
    assert.notEqual(second.tip, '');
    assert.equal(second.content, 'line-one\n');

    // Append through the read→write cycle.
    writeLedger(cloneDir, second.content + 'line-two\n', second.tip);
    const third = readLedger(cloneDir);
    assert.equal(third.content, 'line-one\nline-two\n');

    // The branch is exactly ONE root commit after multiple writes.
    assert.equal(originBranchCommitCount(originDir, LEDGER_BRANCH), '1',
      'push-ledger branch must stay a single root commit');
    // main got ZERO new commits.
    assert.equal(originBranchCommitCount(originDir, 'main'), '1',
      'ledger writes must never add commits to main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('store: stale expected tip is rejected (CAS holds under a lost race)', () => {
  const { tmp, cloneDir } = makeFixture();
  try {
    const initial = readLedger(cloneDir);
    writeLedger(cloneDir, 'writer-A\n', initial.tip);
    const afterA = readLedger(cloneDir);

    // Writer B advances the branch...
    writeLedger(cloneDir, afterA.content + 'writer-B\n', afterA.tip);

    // ...so a write still holding writer A's tip must fail, not clobber B.
    assert.throws(
      () => writeLedger(cloneDir, afterA.content + 'stale-writer\n', afterA.tip),
      /force-with-lease|stale info|rejected/i,
      'a write with a stale expected tip must be rejected by the lease'
    );
    const finalState = readLedger(cloneDir);
    assert.equal(finalState.content, 'writer-A\nwriter-B\n', 'the lost race must not clobber the winner');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readLedger distinguishes branch-absent (fetchFailed=false) from fetch failure (fetchFailed=true)', () => {
  const { tmp, cloneDir } = makeFixture();
  try {
    // Branch doesn't exist yet — normal pre-first-write state, NOT a failure.
    const absent = readLedger(cloneDir);
    assert.equal(absent.fetchFailed, false, 'missing branch must not count as a fetch failure');
    assert.equal(absent.tip, '');

    // Point origin at a nonexistent path — a genuine fetch failure.
    sh(`git remote set-url origin "${path.join(tmp, 'does-not-exist.git')}"`, cloneDir);
    const broken = readLedger(cloneDir);
    assert.equal(broken.fetchFailed, true, 'unreachable remote must set fetchFailed');
    assert.equal(broken.tip, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('record-push-ledger.js end-to-end: entry recorded on push-ledger branch, main untouched, exit 0', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    const out = execFileSync('node', [RECORD_SCRIPT, '--sha=abc123def456', '--branch=main'], {
      cwd: cloneDir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV },
    });
    assert.match(out, /recorded abc123def456/);

    const ledgerContent = sh(`git --git-dir="${originDir}" show ${LEDGER_BRANCH}:${LEDGER_FILE}`);
    const entry = JSON.parse(ledgerContent.trim());
    assert.equal(entry.sha, 'abc123def456');
    assert.equal(entry.branch, 'main');
    assert.equal(originBranchCommitCount(originDir, 'main'), '1',
      'record-push-ledger must not commit to main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('record-push-ledger.js respects PUSH_SKIP_LEDGER=1 and missing --sha (fail open, no writes)', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    execFileSync('node', [RECORD_SCRIPT, '--sha=deadbeef', '--branch=main'], {
      cwd: cloneDir, encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PUSH_SKIP_LEDGER: '1' },
    });
    execFileSync('node', [RECORD_SCRIPT, '--branch=main'], {
      cwd: cloneDir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV },
    });
    assert.throws(() => sh(`git --git-dir="${originDir}" rev-parse ${LEDGER_BRANCH}`),
      /unknown revision|bad revision|fatal/i,
      'no ledger branch should exist after kill-switch/no-sha runs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('record-push-ledger.js canonical-repo gate: non-Broadwayscore origins are NOT ledgered without the override', () => {
  // Ship-check adversarial finding: several workflows run push-with-retry.sh
  // from INSIDE the private data-repo clones. Without this gate the rewrite
  // would grow never-pruned push-ledger branches on those repos.
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    const env = { ...process.env, ...GIT_ENV };
    delete env.PUSH_LEDGER_ANY_ORIGIN;
    const out = execFileSync('node', [RECORD_SCRIPT, '--sha=cafebabe12', '--branch=main'], {
      cwd: cloneDir, encoding: 'utf8', env,
    });
    assert.match(out, /skipping — cwd origin .* is not the canonical Broadwayscore repo/);
    assert.throws(() => sh(`git --git-dir="${originDir}" rev-parse ${LEDGER_BRANCH}`),
      /unknown revision|bad revision|fatal/i,
      'no ledger branch may be created on a non-canonical origin');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
