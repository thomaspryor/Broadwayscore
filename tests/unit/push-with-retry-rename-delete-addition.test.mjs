/**
 * BRO-5494 regression: opening-night-poller.yml run 38922225821 lost 17 review
 * files. Our commit deleted _pending/midnight/theater-scene--209c52ac.json and
 * ADDED memoirs/thewrap--robert-hofler.json; git's rename detection paired the
 * two, the remote had also deleted the _pending/ file, so the rebase reported
 * rename/delete + modify/delete on OUR NEW path. resolve_conflicts() took the
 * "accept deletion" arm (remote "deleted" a path it never had), rm'd the new
 * review, and the post-rebase survival check aborted the whole push.
 *
 * These tests source the REAL classifier (scripts/lib/modify-delete-conflict.sh)
 * against a real stopped rebase, and run the REAL push-with-retry.sh end to end
 * against a bare remote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.resolve(fileURLToPath(new URL('../../scripts/lib/', import.meta.url)));
const SCRIPT = path.join(LIB, 'push-with-retry.sh');
const HELPER = path.join(LIB, 'modify-delete-conflict.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  GITHUB_ACTIONS: '',
};

function sh(cmd, cwd, extraEnv = {}) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV, ...extraEnv } }).toString();
}

const PENDING = '_pending/midnight-off-broadway-2026/theater-scene--209c52ac.json';
const NEWFILE = 'memoirs-of-amorous-gentlemen-off-broadway-2026/thewrap--robert-hofler.json';
const RENAMED_ON_REMOTE = 'fish-off-broadway-2026/exeunt-magazine--unknown.json';

// Real-shaped review JSON; the two records share most keys so git's rename
// detection pairs them (the incident was 56% similar).
function review(showId, outlet, critic, url, extra = {}) {
  return JSON.stringify({
    showId, outletId: outlet, outlet, criticName: critic, url,
    publishDate: 'October 15, 2026', fullText: null, isFullReview: false,
    dtliExcerpt: null, bwwExcerpt: null, source: 'opening-night-poller',
    contentTier: 'stub', llmScore: null, assignedScore: null, ...extra,
  }, null, 2) + '\n';
}

function write(dir, rel, body) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

// origin (bare) + seed (the concurrent writer) + runner (this job's checkout),
// with the incident's shape: base has the _pending/ file and an --unknown file;
// runner deletes _pending/ + adds a new review + edits the --unknown file;
// remote deletes _pending/ and renames the --unknown file to a named critic.
function buildFixture(tmp) {
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');
  sh(`git init -q --bare "${originDir}"`, tmp);
  for (const k of ['gc.auto 0', 'gc.autoDetach false', 'maintenance.auto false', 'receive.autogc false']) {
    sh(`git -C "${originDir}" config ${k}`, tmp);
  }
  sh(`git init -q "${seedDir}"`, tmp);
  write(seedDir, PENDING, review('midnight-off-broadway-2026', 'theater-scene', 'Unknown', 'https://example.test/midnight'));
  write(seedDir, RENAMED_ON_REMOTE, review('fish-off-broadway-2026', 'exeunt-magazine', 'Unknown', 'https://example.test/fish'));
  sh('git add -A && git commit -q -m base && git branch -M main', seedDir);
  sh(`git push -q "${originDir}" main`, seedDir);

  sh(`git clone -q -b main "${originDir}" runner`, tmp);
  sh('git rm -q -- ' + PENDING, runnerDir);
  write(runnerDir, NEWFILE, review('memoirs-of-amorous-gentlemen-off-broadway-2026', 'thewrap', 'Robert Hofler', 'https://example.test/memoirs'));
  write(runnerDir, RENAMED_ON_REMOTE, review('fish-off-broadway-2026', 'exeunt-magazine', 'Unknown', 'https://example.test/fish', { publishDate: 'October 16, 2026' }));
  sh('git add -A && git commit -q -m "data: Opening night poller — new reviews discovered"', runnerDir);
  const stat = sh('git show --format= --name-status -M HEAD', runnerDir);
  assert.match(stat, /^R\d+\t/m, `fixture must reproduce git rename pairing, got:\n${stat}`);

  sh('git rm -q -- ' + PENDING, seedDir);
  sh(`git mv ${RENAMED_ON_REMOTE} fish-off-broadway-2026/exeunt-magazine--named-critic.json`, seedDir);
  sh('git commit -q -m "concurrent: promote pending + rename critic"', seedDir);
  sh(`git push -q "${originDir}" main`, seedDir);
  return { originDir, seedDir, runnerDir };
}

function classify(runnerDir, file) {
  return sh(`bash -c 'PULL_BRANCH=main; source "${HELPER}"; is_modify_delete "$1" rebase; echo "rc=$? del=$IS_DELETED_LOCALLY add=$IS_LOCAL_ADDITION"' _ "${file}"`, runnerDir).trim();
}

test('classifier: a path the remote never had is a local addition; a real remote rename is not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5494-classify-'));
  try {
    const { runnerDir } = buildFixture(tmp);
    sh('git fetch -q origin', runnerDir);
    let stopped = false;
    try { sh('git rebase -X theirs origin/main', runnerDir); } catch { stopped = true; }
    assert.ok(stopped, 'fixture must stop the rebase on a conflict');
    const conflicted = sh('git diff --name-only --diff-filter=U', runnerDir).trim().split('\n');
    assert.ok(conflicted.includes(NEWFILE), `expected ${NEWFILE} conflicted, got ${conflicted}`);
    assert.equal(classify(runnerDir, NEWFILE), 'rc=0 del=false add=true');
    // Control: the remote really renamed this --unknown file away (base had it),
    // so the accept-deletion arm must still fire for it.
    assert.equal(classify(runnerDir, RENAMED_ON_REMOTE), 'rc=0 del=false add=false');
    sh('git rebase --abort', runnerDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('push-with-retry.sh keeps our added review instead of deleting it and the push lands', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5494-e2e-'));
  try {
    const { originDir, runnerDir } = buildFixture(tmp);
    const expected = fs.readFileSync(path.join(runnerDir, NEWFILE), 'utf8');
    let out = '';
    let code = 0;
    try {
      out = sh(`bash "${SCRIPT}" 3 main 2>&1`, runnerDir, { PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'), PUSH_DEADLINE_SEC: '120' });
    } catch (err) {
      code = err.status ?? 1;
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }
    const tail = out.split('\n').slice(-40).join('\n');
    assert.equal(code, 0, `push-with-retry.sh failed:\n${tail}`);
    assert.match(out, /keep local addition/, `expected the BRO-5494 arm to fire:\n${tail}`);
    const landed = sh(`git --git-dir="${originDir}" show main:${NEWFILE}`, tmp);
    assert.equal(landed, expected, 'new review must reach origin byte-identical');
    const tree = sh(`git --git-dir="${originDir}" ls-tree -r --name-only main`, tmp);
    assert.ok(!tree.includes(PENDING), 'the _pending/ file stays deleted');
    assert.ok(!tree.includes(RENAMED_ON_REMOTE), 'the remote rename still wins for the --unknown file');
    assert.ok(tree.includes('fish-off-broadway-2026/exeunt-magazine--named-critic.json'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
