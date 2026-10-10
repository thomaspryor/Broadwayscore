// BRO-4238: cloud sessions never push main directly; they land via land/**.
// Drives the real .claude/hooks/pre-push-review-gate.sh (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'pre-push-review-gate.sh');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4238-push-'));
const transcript = path.join(scratch, 'transcript.jsonl');
fs.writeFileSync(transcript, '');
// A HOME without ~/.claude/hooks so the repo copy never self-skips (Mac-like HOME would).
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome);
// Another repo (not Broadwayscore) whose sessions may push their own main.
const otherRepo = path.join(scratch, 'other');
fs.mkdirSync(otherRepo);
execFileSync('git', ['init', '-q', '-b', 'main', otherRepo]);
execFileSync('git', ['-C', otherRepo, 'remote', 'add', 'origin', 'https://github.com/thomaspryor/brownstone-model']);
// Give it a COPY of the gate's libs (a symlink breaks transcript-scan.mjs's
// is-main check, so the hook would exit early) so it reaches the remote check instead of
// exiting early for "not a repo with the libs" (review finding).
fs.mkdirSync(path.join(otherRepo, 'scripts'));
fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(otherRepo, 'scripts', 'lib'), { recursive: true });
// Same shape for the iOS app repo, whose name starts with 'broadwayscore'.
const appRepo = path.join(scratch, 'app');
fs.mkdirSync(appRepo);
execFileSync('git', ['init', '-q', '-b', 'main', appRepo]);
execFileSync('git', ['-C', appRepo, 'remote', 'add', 'origin', 'https://github.com/thomaspryor/BroadwayScorecard-app']);
fs.mkdirSync(path.join(appRepo, 'scripts'));
fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(appRepo, 'scripts', 'lib'), { recursive: true });
// Control fixture: identical shape but pointed at this repo, so if the
// other-repo cases pass only because the hook exits early, this one fails.
const bwsRepo = path.join(scratch, 'bws');
fs.mkdirSync(bwsRepo);
execFileSync('git', ['init', '-q', '-b', 'main', bwsRepo]);
execFileSync('git', ['-C', bwsRepo, 'remote', 'add', 'origin', 'https://github.com/thomaspryor/Broadwayscore']);
fs.mkdirSync(path.join(bwsRepo, 'scripts'));
fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(bwsRepo, 'scripts', 'lib'), { recursive: true });
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function run(command, { cwd = REPO_ROOT, env = {} } = {}) {
  const r = spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ tool_input: { command }, session_id: 'bro-4238-test', transcript_path: transcript, tool_use_id: 'tu-1' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: cwd, LAND_ENFORCE_OFF: '', ...env },
    timeout: 60000,
  });
  return { status: r.status, stderr: r.stderr || '' };
}
const blockedByLand = (r) => r.status === 2 && /never push main directly \(BRO-4238\)/.test(r.stderr);

for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git -C . push origin HEAD:main', 'FOO=1 git push origin HEAD:main', 'git commit -m x && git push origin main',
  'git -c user.name=x push origin HEAD:main', 'git --no-pager push origin HEAD:main', 'command git push origin HEAD:main', 'time git push origin HEAD:main',
  'git push origin "HEAD:main"', 'git push origin +HEAD:main', 'git push --force origin HEAD:main', 'bash scripts/lib/push-with-retry.sh 3 main']) {
  test(`blocks a direct push to main: ${cmd}`, () => {
    const r = run(cmd);
    assert.ok(blockedByLand(r), `expected the land block, got exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /refs\/heads\/land\/<name>/, 'must say how to land');
  });
}

for (const cmd of ['git push origin HEAD:refs/heads/land/fix-x', 'git push origin HEAD:land/main', 'git push origin claude/some-branch', 'grep -n "git push origin main" CLAUDE.md', 'ls -la']) {
  test(`does not land-block: ${cmd}`, () => {
    assert.ok(!blockedByLand(run(cmd)), `must not trip the land block for: ${cmd}`);
  });
}

test('the emergency override lets the command past the land block (prefix and env)', () => {
  assert.ok(!blockedByLand(run('LAND_ENFORCE_OFF=1 git push origin HEAD:main')));
  assert.ok(!blockedByLand(run('git push origin HEAD:main', { env: { LAND_ENFORCE_OFF: '1' } })));
});

test('other repos may push their own main (routines like the investments sync), incl. the similarly named app repo', () => {
  assert.ok(!blockedByLand(run('git push origin HEAD:main', { cwd: otherRepo })));
  assert.ok(!blockedByLand(run('git push origin HEAD:main', { cwd: appRepo })));
});

test('control: the same fixture shape pointed at this repo IS blocked (the other-repo passes are the remote check, not an early exit)', () => {
  const r = run('git push origin HEAD:main', { cwd: bwsRepo });
  assert.ok(blockedByLand(r), `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
});
