/**
 * check-push-ledger-content-check.test.mjs — BRO-2304.
 *
 * checkContentSurvived() (scripts/check-push-ledger.js) is check-push-ledger.js's
 * fallback for when the GitHub compare API says a previously-verified push's sha
 * is no longer reachable from its branch's tip. Before that fires an owner-alert
 * card, this asks push-content-survival.js's own classifier (the same one
 * push-with-retry.sh trusts at push time) whether the commit's actual file
 * content is still provably present — catching the case where a later
 * conflict-resolution/rebase step recreated the same content under a brand-new
 * sha (benign) rather than genuinely discarding it (the real #619/#668 class).
 *
 * Uses a real local bare repo as `origin` — the whole contract here is git
 * plumbing (fetch-by-raw-sha, blob comparison), so a mocked git would test
 * nothing. Mirrors tests/unit/push-ledger-store.test.mjs's fixture shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CHECK_PUSH_LEDGER = path.resolve(fileURLToPath(new URL('../../scripts/check-push-ledger.js', import.meta.url)));
const { checkContentSurvived } = require(CHECK_PUSH_LEDGER);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString().trim();
}

function writeFile(cwd, name, content) {
  fs.writeFileSync(path.join(cwd, name), content);
}

// Builds: origin.git (bare) <- clone (main with one root commit, pushed).
// Returns a second, independent clone ("writer") for creating the entry's own
// commit(s) without disturbing `clone`'s working tree state.
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-push-ledger-content-'));
  const originDir = path.join(tmp, 'origin.git');
  const cloneDir = path.join(tmp, 'clone');
  sh(`git init -q --bare "${originDir}"`, tmp);
  sh(`git init -q "${cloneDir}"`, tmp);
  sh('git config user.email t@t.t', cloneDir);
  sh('git config user.name t', cloneDir);
  writeFile(cloneDir, 'README.md', 'root\n');
  sh('git add README.md', cloneDir);
  sh('git commit -q -m root', cloneDir);
  sh('git branch -M main', cloneDir);
  sh(`git remote add origin "${originDir}"`, cloneDir);
  sh('git push -q origin main', cloneDir);
  const rootSha = sh('git rev-parse HEAD', cloneDir);
  return { tmp, originDir, cloneDir, rootSha };
}

// The re-check runs from a THIRD clone (mirrors the real caller: a fresh
// check-push-ledger.yml checkout, not the writer's own working directory).
function makeCheckerClone(tmp, originDir) {
  const checkerDir = path.join(tmp, 'checker');
  sh(`git clone -q "${originDir}" "${checkerDir}"`, tmp);
  return checkerDir;
}

test('checkContentSurvived: genuine revert (branch reset back to pre-edit base) -> false', () => {
  const { tmp, originDir, cloneDir, rootSha } = makeFixture();
  try {
    sh('git checkout -q -b feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'echo our-real-change\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "add gate"', cloneDir);
    const entrySha = sh('git rev-parse HEAD', cloneDir);
    sh('git push -q origin feature', cloneDir);

    // Simulate a concurrent operation reverting feature back to pre-edit base
    // (the genuine #619/#668 signature) — force-push root straight onto feature.
    sh(`git push -q -f origin ${rootSha}:refs/heads/feature`, cloneDir);

    const checkerDir = makeCheckerClone(tmp, originDir);
    const result = checkContentSurvived(checkerDir, { sha: entrySha, branch: 'feature' });
    assert.equal(result, false, 'a genuine revert to pre-edit base must not be suppressed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('checkContentSurvived: content carried forward byte-identical under a new sha -> true', () => {
  const { tmp, originDir, cloneDir, rootSha } = makeFixture();
  try {
    sh('git checkout -q -b feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'echo our-real-change\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "add gate"', cloneDir);
    const entrySha = sh('git rev-parse HEAD', cloneDir);
    sh('git push -q origin feature', cloneDir);

    // Simulate a rebase that recreates the identical content under a new sha
    // (task #619's 'superseded' shape): reset to root, recommit the SAME
    // file content with a different message/timestamp, force-push.
    sh(`git checkout -q ${rootSha}`, cloneDir);
    sh('git checkout -q -B feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'echo our-real-change\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "add gate (rebased)"', cloneDir);
    sh('git push -q -f origin feature', cloneDir);

    const checkerDir = makeCheckerClone(tmp, originDir);
    const result = checkContentSurvived(checkerDir, { sha: entrySha, branch: 'feature' });
    assert.equal(result, true, 'byte-identical content carried forward under a new sha must be suppressed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('checkContentSurvived: content carried forward as a pure superset (later commit adds more) -> true', () => {
  const { tmp, originDir, cloneDir, rootSha } = makeFixture();
  try {
    sh('git checkout -q -b feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'echo our-real-change\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "add gate"', cloneDir);
    const entrySha = sh('git rev-parse HEAD', cloneDir);
    sh('git push -q origin feature', cloneDir);

    // A sibling commit (not a descendant of entrySha) that independently
    // contains our exact added line PLUS extra content on top — the
    // "ambiguous, but our added lines are all present" shape.
    sh(`git checkout -q ${rootSha}`, cloneDir);
    sh('git checkout -q -B feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'echo our-real-change\necho extra-from-later-work\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "add gate plus more"', cloneDir);
    sh('git push -q -f origin feature', cloneDir);

    const checkerDir = makeCheckerClone(tmp, originDir);
    const result = checkContentSurvived(checkerDir, { sha: entrySha, branch: 'feature' });
    assert.equal(result, true, 'our added lines surviving inside a later superset commit must be suppressed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('checkContentSurvived: entry sha was never pushed anywhere (unfetchable) -> false', () => {
  const { tmp, originDir, cloneDir } = makeFixture();
  try {
    sh('git checkout -q -b feature', cloneDir);
    sh('git push -q origin feature', cloneDir);
    const fakeSha = '0123456789abcdef0123456789abcdef01234567';

    const checkerDir = makeCheckerClone(tmp, originDir);
    const result = checkContentSurvived(checkerDir, { sha: fakeSha, branch: 'feature' });
    assert.equal(result, false, 'an unfetchable/never-pushed sha must not be suppressed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('checkContentSurvived: our own added lines genuinely clobbered by a concurrent edit -> false (task #833 signature)', () => {
  const { tmp, originDir, cloneDir, rootSha } = makeFixture();
  try {
    sh('git checkout -q -b feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'line1\nline2\nline3\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "base lines"', cloneDir);
    sh('git push -q origin feature', cloneDir);

    writeFile(cloneDir, 'gate.sh', 'line1\nOUR-REAL-ADDITION\nline2\nline3\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "our addition"', cloneDir);
    const entrySha = sh('git rev-parse HEAD', cloneDir);
    sh('git push -q origin feature', cloneDir);

    // A concurrent edit that touches the file elsewhere WITHOUT carrying our
    // addition forward — final differs from both base and local, but our
    // added line is genuinely missing (not a legitimate merge).
    sh(`git checkout -q ${rootSha}`, cloneDir);
    sh('git checkout -q -B feature', cloneDir);
    writeFile(cloneDir, 'gate.sh', 'line1\nline2\nCONCURRENT-UNRELATED-EDIT\nline3\n');
    sh('git add gate.sh', cloneDir);
    sh('git commit -q -m "concurrent edit, does not carry our addition"', cloneDir);
    sh('git push -q -f origin feature', cloneDir);

    const checkerDir = makeCheckerClone(tmp, originDir);
    const result = checkContentSurvived(checkerDir, { sha: entrySha, branch: 'feature' });
    assert.equal(result, false, 'a clobbered addition inside an otherwise-changed file must not be suppressed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
