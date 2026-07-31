// End-to-end fixture for task #698: two concurrent opening-night-poller runs
// (per-show_id concurrency group — different shows run in parallel) append
// misses to the shared data/audit/bww-roundup-miss-ledger.jsonl and push via
// push-with-retry.sh. Mirrors reconcile-coverage.test.mjs's #420 fixture but
// for the JSONL reconcile path added by merge-bww-roundup-ledger.js /
// reconcile-merged-json.js's `format: 'jsonl'` support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUSH_SH = path.join(REPO_ROOT, 'scripts', 'lib', 'push-with-retry.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function ledgerLines(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('PUSH_RECONCILE_MERGED_JSON=1 survives two concurrent poller runs appending misses for DIFFERENT shows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-bww-ledger-'));
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');

  try {
    sh(`git init -q --bare "${originDir}"`, tmp);
    sh(`git init -q "${seedDir}"`, tmp);
    sh('git config user.email t@t.t', seedDir);
    sh('git config user.name t', seedDir);

    // Base state: one prior miss already on the ledger.
    fs.mkdirSync(path.join(seedDir, 'data', 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(seedDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
      JSON.stringify({ ts: '2026-07-29T10:00:00.000Z', showId: 'base-show' }) + '\n',
    );
    sh('git add -A', seedDir);
    sh('git commit -q -m base', seedDir);
    sh('git branch -M main', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    // --branch main explicitly (not a bare clone following HEAD) — see the
    // #420 fixture's comment on why: an ambiguous default branch on the bare
    // origin can check out an EMPTY working tree on some git configs.
    sh(`git clone -q --branch main "${originDir}" "${runnerDir}"`, tmp);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);

    // Concurrent poller run: another show_id's run appends its own miss and
    // pushes FIRST, landing on origin/main before our push attempt.
    sh(`git clone -q --branch main "${originDir}" "${seedDir}-concurrent"`, tmp);
    const concurrentDir = `${seedDir}-concurrent`;
    sh('git config user.email t@t.t', concurrentDir);
    sh('git config user.name t', concurrentDir);
    fs.appendFileSync(
      path.join(concurrentDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
      JSON.stringify({ ts: '2026-07-30T09:00:00.000Z', showId: 'show-b-concurrent' }) + '\n',
    );
    sh('git add -A', concurrentDir);
    sh('git commit -q -m "concurrent poller run: miss for show-b"', concurrentDir);
    sh('git push -q origin main', concurrentDir);

    // Our own poller run: appends a DIFFERENT show's miss on top of the
    // (now stale) base — this is the commit push-with-retry.sh must rebase.
    fs.appendFileSync(
      path.join(runnerDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
      JSON.stringify({ ts: '2026-07-30T09:05:00.000Z', showId: 'show-a-ours' }) + '\n',
    );
    sh('git add -A', runnerDir);
    sh('git commit -q -m "our poller run: miss for show-a"', runnerDir);

    // Sanity check: a PLAIN `git rebase -X theirs` reports success with no
    // conflict, and the concurrent run's appended line is gone — this is the
    // exact bug task #698 exists to fix (same class as #420's JSON fixture).
    const bugCheckDir = `${runnerDir}-bugcheck`;
    sh(`git clone -q --branch main "${runnerDir}" "${bugCheckDir}"`, tmp);
    sh('git config user.email t@t.t', bugCheckDir);
    sh('git config user.name t', bugCheckDir);
    sh('git fetch -q origin main', bugCheckDir);
    const rebaseOut = sh('git rebase -X theirs origin/main', bugCheckDir);
    assert.match(rebaseOut, /Successfully rebased|up to date/i);
    const bugCheckLines = ledgerLines(
      fs.readFileSync(path.join(bugCheckDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'), 'utf8'),
    );
    assert.ok(
      !bugCheckLines.some((e) => e.showId === 'show-b-concurrent'),
      'sanity check: plain -X theirs silently drops the concurrent run\'s appended miss',
    );

    // Now the REAL fix: push through push-with-retry.sh with the flag on.
    execFileSync('bash', [PUSH_SH, '3', 'main'], {
      cwd: runnerDir,
      env: {
        ...process.env, ...GIT_ENV,
        PUSH_RECONCILE_MERGED_JSON: '1',
        PUSH_FAILURE_LOG: path.join(tmp, 'push-retry-failures.jsonl'),
      },
      stdio: 'pipe',
    });

    sh('git fetch -q origin main', runnerDir);
    const finalLines = ledgerLines(sh('git show origin/main:data/audit/bww-roundup-miss-ledger.jsonl', runnerDir));
    const finalShowIds = finalLines.map((e) => e.showId).sort();
    assert.deepEqual(finalShowIds, ['base-show', 'show-a-ours', 'show-b-concurrent'].sort(),
      'both concurrent runs\' misses must survive on origin/main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
