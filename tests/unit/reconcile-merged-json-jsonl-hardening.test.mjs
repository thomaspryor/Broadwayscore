// Regression tests for two ship-check findings on the JSONL reconcile path
// added for task #698 (scripts/lib/reconcile-merged-json.js):
//   1. A corrupt (unparsable) local line must never be silently dropped and
//      committed away — reconciliation should skip that file, not truncate it.
//   2. reconcile-merged-json.js must work when invoked from a cwd other than
//      repo root (the exact `cd data` class of bug this task fixed) — a
//      regression guard so a future re-introduction of a `cd` before the
//      push-with-retry.sh call is caught here instead of only in prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RECONCILE_JS = path.join(REPO_ROOT, 'scripts', 'lib', 'reconcile-merged-json.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function makeFixture(tmp) {
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  sh(`git init -q --bare "${originDir}"`, tmp);
  sh(`git init -q "${seedDir}"`, tmp);
  sh('git config user.email t@t.t', seedDir);
  sh('git config user.name t', seedDir);
  fs.mkdirSync(path.join(seedDir, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(seedDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
    JSON.stringify({ ts: '2026-07-29T10:00:00.000Z', showId: 'base-show' }) + '\n',
  );
  sh('git add -A', seedDir);
  sh('git commit -q -m base', seedDir);
  sh('git branch -M main', seedDir);
  sh(`git push -q "${originDir}" main`, seedDir);
  return { originDir };
}

test('a corrupt local line fails OPEN (skips reconciliation) instead of silently dropping it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-jsonl-corrupt-'));
  try {
    const { originDir } = makeFixture(tmp);
    const runnerDir = path.join(tmp, 'runner');
    sh(`git clone -q --branch main "${originDir}" "${runnerDir}"`, tmp);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);

    const ledgerPath = path.join(runnerDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl');
    const corruptContent = JSON.stringify({ ts: '2026-07-29T10:00:00.000Z', showId: 'base-show' }) + '\n'
      + '{"ts": "2026-07-30T09:00:00.000Z", "showId": "torn-line"' // deliberately truncated/unparsable
      + '\n';
    fs.writeFileSync(ledgerPath, corruptContent);

    // Remote has an independent addition, so the merge WOULD have work to do
    // if it ran — proving the skip is because of the corrupt line, not a no-op.
    const writerDir = path.join(tmp, 'writer');
    sh(`git clone -q --branch main "${originDir}" "${writerDir}"`, tmp);
    sh('git config user.email t@t.t', writerDir);
    sh('git config user.name t', writerDir);
    fs.appendFileSync(
      path.join(writerDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
      JSON.stringify({ ts: '2026-07-30T09:30:00.000Z', showId: 'remote-addition' }) + '\n',
    );
    sh('git add -A', writerDir);
    sh('git commit -q -m "remote addition"', writerDir);
    sh('git push -q origin main', writerDir);
    sh('git fetch -q origin main', runnerDir);

    const before = fs.readFileSync(ledgerPath, 'utf8');
    const out = execFileSync('node', [RECONCILE_JS, 'origin/main', 'data/audit/bww-roundup-miss-ledger.jsonl'], {
      cwd: runnerDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const after = fs.readFileSync(ledgerPath, 'utf8');

    assert.equal(out.trim(), '', 'a corrupt-line file must never be reported as reconciled/changed');
    assert.equal(after, before, 'the file on disk must be byte-identical — corrupt line preserved, not silently dropped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-merged-json.js resolves MANAGED paths correctly even when invoked from a non-root cwd (the `cd data` class bug)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-jsonl-cwd-'));
  try {
    const { originDir } = makeFixture(tmp);
    const runnerDir = path.join(tmp, 'runner');
    sh(`git clone -q --branch main "${originDir}" "${runnerDir}"`, tmp);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);

    fs.appendFileSync(
      path.join(runnerDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
      JSON.stringify({ ts: '2026-07-30T09:05:00.000Z', showId: 'local-addition' }) + '\n',
    );

    const writerDir = path.join(tmp, 'writer');
    sh(`git clone -q --branch main "${originDir}" "${writerDir}"`, tmp);
    sh('git config user.email t@t.t', writerDir);
    sh('git config user.name t', writerDir);
    fs.appendFileSync(
      path.join(writerDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'),
      JSON.stringify({ ts: '2026-07-30T09:30:00.000Z', showId: 'remote-addition' }) + '\n',
    );
    sh('git add -A', writerDir);
    sh('git commit -q -m "remote addition"', writerDir);
    sh('git push -q origin main', writerDir);
    sh('git fetch -q origin main', runnerDir);

    // Invoke from data/ — reproduces the poller step's old `cd data` cwd.
    const cwdInsideData = path.join(runnerDir, 'data');
    const out = execFileSync('node', [RECONCILE_JS, 'origin/main', 'data/audit/bww-roundup-miss-ledger.jsonl'], {
      cwd: cwdInsideData,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(out.trim(), 'data/audit/bww-roundup-miss-ledger.jsonl', 'must still find and reconcile the file despite the non-root cwd');
    const finalLines = fs.readFileSync(path.join(runnerDir, 'data', 'audit', 'bww-roundup-miss-ledger.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const showIds = finalLines.map((e) => e.showId).sort();
    assert.deepEqual(showIds, ['base-show', 'local-addition', 'remote-addition'].sort());
    // Also confirm nothing leaked into a phantom data/data/audit/ path.
    assert.equal(fs.existsSync(path.join(runnerDir, 'data', 'data')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
