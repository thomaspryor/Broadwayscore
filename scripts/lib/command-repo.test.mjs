import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCommandRepo } from './command-repo.mjs';

// realpath: on macOS os.tmpdir() can be /tmp, a symlink to /private/tmp, and git
// reports the resolved path, so a symlinked scratch never matches (BRO-6536 land).
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'command-repo-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
const own = path.join(scratch, 'own');
const other = path.join(scratch, 'other');
const nonRepo = path.join(scratch, 'scratchpad');
fs.mkdirSync(nonRepo);
for (const dir of [own, other]) execFileSync('git', ['init', '-q', dir]);
execFileSync('git', ['-C', own, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
const worktree = path.join(scratch, 'own worktree');
execFileSync('git', ['-C', own, 'worktree', 'add', '-q', '-b', 'fixture', worktree]);
const resolve = (command, operation = 'push') => resolveCommandRepo(command, { cwd: own, canonicalRoot: own, operation });
const generated = (target) => `cd ${nonRepo}\ncat > ts.sh <<'SH'\ncd "${target}"\ngit push origin main\nSH\nbash ts.sh`;

test('resolves generated scripts after a scratchpad cd, including own linked worktrees', () => {
  assert.equal(resolve(generated(other)).outOfScope, true);
  assert.deepEqual(resolve(generated(worktree)), { outOfScope: false, evalRoot: worktree });
});

test('subshell cd does not escape and a quoted return to our repo stays guarded', () => {
  assert.equal(resolve(`cd ${nonRepo}; (cd ${other} && true); git push origin main`).outOfScope, false);
  assert.equal(resolve(`cd ${nonRepo}; cd ${other}; cd "${own}"; git push origin main`).outOfScope, false);
  assert.equal(resolve(`cd ${nonRepo}; cd ${other} | true; git push origin main`).outOfScope, false);
  assert.equal(resolve(`false && cd ${other}; git push origin main`).outOfScope, false);
});

test('any own-family operation keeps mixed repository commands in scope', () => {
  assert.equal(resolve(`cd ${other}; git push origin main; cd ${own}; git push origin main`).outOfScope, false);
  assert.equal(resolve(`cd ${other}; git -C ${own} push origin main`).outOfScope, false);
  assert.equal(resolve(`git -C ${other} push origin main`).outOfScope, true);
});

test('literal prose and unexecuted heredocs do not provide repository exemptions', () => {
  assert.equal(resolve(`echo 'cd ${other}'; git push origin main`).outOfScope, false);
  assert.equal(resolve(`cat > ts.sh <<'SH'\ncd ${other}\ngit push origin main\nSH\ngit push origin main`).outOfScope, false);
  assert.equal(resolve(`cat > "$SCRIPT" <<'SH'\ncd ${other}\ngit push origin main\nSH\nbash "$SCRIPT"`).outOfScope, false);
});

test('relative cd, nested shell and eval follow their real scope', () => {
  assert.equal(resolve(`cd ${nonRepo}; cd ../other; git push origin main`).outOfScope, true);
  assert.equal(resolve(`bash -c 'cd ${other}; git push origin main'`).outOfScope, true);
  assert.equal(resolve(`eval 'cd ${other}'; git push origin main`).outOfScope, true);
  assert.equal(resolve(`bash -c 'cd ${other}'; git push origin main`).outOfScope, false);
  assert.equal(resolve(`bash -o pipefail -c 'cd ${other}; git push origin main'`).outOfScope, true);
  assert.equal(resolve(`bash -c -- 'cd ${other}; git push origin main'`).outOfScope, true);
  assert.equal(resolve(`bash unknown.sh -c 'cd ${other}; git push origin main'`).outOfScope, false);
  assert.equal(resolve(`bash -n -c 'cd ${other}; git push origin main'`).outOfScope, false);
});

test('merge commands and existing shell helpers are recognized', () => {
  for (const command of ['git merge feature', 'gh pr merge 1', 'bash scripts/merge-worktree-to-main.sh', 'bash scripts/lib/push-with-retry.sh']) {
    assert.equal(resolve(`cd ${other}; ${command}`, 'merge').outOfScope, true, command);
  }
});

test('dynamic directories and mixed unknown targets stay in scope', () => {
  assert.equal(resolve('cd "$TARGET"; git push origin main').outOfScope, false);
  assert.equal(resolve(`git -C ${other} push origin main; cd "$TARGET"; git push origin main`).outOfScope, false);
  assert.equal(resolve(`GIT_DIR=${own}/.git bash -c 'cd ${other}; git push origin main'`).outOfScope, false);
  assert.equal(resolve('bash unknown.sh').outOfScope, false);
  assert.equal(resolve(`cd "$TARGET"; cd ../other; git push origin main`).outOfScope, false);
  assert.equal(resolve(`source unknown.sh; cd ../other; git push origin main`).outOfScope, false);
  assert.equal(resolve(`source unknown.sh; cd ${other}; git push origin main`).outOfScope, false);
  assert.equal(resolve(`cd ${other}; git push origin main; bash unknown.sh`).outOfScope, false);
  assert.equal(resolve(`cd ${scratch}/missing && cd ${other}; git push origin main`).outOfScope, false);
});

test('ordinary external add/commit/push chains remain exempt', () => {
  assert.equal(resolve(`cd ${other} && git add . && git commit -m fixture && git push origin main`).outOfScope, true);
  assert.equal(resolve(`cd ${other}; git add . && git commit -m fixture && git push origin main`).outOfScope, true);
});

test('pipelines, redirections, backgrounds and retries preserve known push directories', () => {
  for (const tail of [
    'git push origin main 2>&1 | tail -3',
    'git push origin main || git push origin main',
    'git push origin main || (git pull --rebase && git push origin main)',
    'git push origin main &',
    '2>&1 git push origin main | tail -3',
  ]) {
    assert.equal(resolve(`cd ${other}; ${tail}`).outOfScope, true, tail);
    assert.deepEqual(resolve(`cd "${worktree}"; ${tail}`), { outOfScope: false, evalRoot: worktree }, tail);
  }
  assert.equal(resolve(`true | cat; cd ${other}; git push origin main`).outOfScope, true);
  assert.equal(resolve(`cd ${other}; git push origin main; true || cd ${own}`).outOfScope, true);
});

test('conditional and isolated directory changes cannot provide an exemption', () => {
  for (const prefix of [
    `cd ${other} | cat`,
    `true | cd ${other}`,
    `cd ${other} &`,
    `cd ${other} && true &`,
    `true || cd ${other}`,
  ]) assert.equal(resolve(`${prefix}; git push origin main`).outOfScope, false, prefix);
});

test('conditional branches cannot provide a speculative repository exemption', () => {
  assert.equal(resolve(`if false; then\ncd ${other}\nfi; git push origin main`).outOfScope, false);
  assert.equal(resolve(`cd ${other}; if true; then cd ${own}; fi; git push origin main`).outOfScope, false);
});
