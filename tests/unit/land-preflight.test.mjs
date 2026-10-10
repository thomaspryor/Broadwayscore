// BRO-4593: land preflight (scripts/lib/land-preflight.mjs + push-command.mjs
// + .claude/hooks/pre-push-land-preflight.sh). Temp git repos only; every
// rebase verdict is cross-checked against the real scripts/lib/land-rebase.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePushCommand, landPushTargets } from '../../scripts/lib/push-command.mjs';
import { previewRebase, checkTestRegistration, runHook, blockMessage } from '../../scripts/lib/land-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(ROOT, '.claude', 'hooks', 'pre-push-land-preflight.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const tmps = [];
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

function sh(cwd, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'land-preflight-'));
  tmps.push(d);
  return d;
}
function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
/** repo with main: f.txt (5 lines) and g.txt; returns dir. */
function baseRepo() {
  const d = tmp();
  sh(d, 'git init -q -b main . && git config gc.auto 0 && git config gc.autoDetach false && git config maintenance.auto false');
  write(d, 'f.txt', 'a\nb\nc\nd\ne\n');
  write(d, 'g.txt', 'one\n');
  sh(d, 'git add -A && git commit -qm init');
  return d;
}
/** What the real land step does: plain `git rebase main` via land-rebase.sh in a throwaway clone. */
function realLandRebase(dir, tip) {
  const c = tmp();
  const sha = sh(dir, `git rev-parse ${tip}`).trim();
  sh(c, `git clone -q "${dir}" . && git checkout -q --detach ${sha}`);
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/lib/land-rebase.sh'), 'origin/main', 'test'], { cwd: c, env: ENV, encoding: 'utf8' });
  return r.status === 0 ? 'clean' : 'conflict';
}
function assertParity(dir, tip) {
  const p = previewRebase({ base: 'main', tip, cwd: dir });
  assert.equal(p.status, realLandRebase(dir, tip), `preview ${JSON.stringify(p)} disagrees with land-rebase.sh`);
  return p;
}

// ── push command parsing ───────────────────────────────────────────────────
test('parser: land push forms are recognised with their source', () => {
  const cases = [
    ['git push origin HEAD:refs/heads/land/x', 'HEAD', 'land/x'],
    ['git push origin HEAD:land/x', 'HEAD', 'land/x'],
    ['git push -u origin land/x', 'land/x', 'land/x'],
    ['git push -q -o ci.skip origin "HEAD:refs/heads/land/x" 2>&1 | tail -3', 'HEAD', 'land/x'],
    ['/usr/bin/git push origin abc123:land/x', 'abc123', 'land/x'],
    ['git push origin +HEAD:land/x', 'HEAD', 'land/x'],
  ];
  for (const [cmd, src, dst] of cases) {
    const t = landPushTargets(cmd);
    assert.equal(t.length, 1, cmd);
    assert.equal(t[0].src, src, cmd);
    assert.equal(t[0].dst, dst, cmd);
    assert.equal(t[0].push.remote, 'origin', cmd);
  }
});

test('parser: mentions of a land push are not pushes; deletes and non-land pushes are ignored', () => {
  for (const cmd of [
    'git commit -m "then git push origin HEAD:refs/heads/land/x"',
    'echo git push origin HEAD:land/x',
    "grep -n 'git push origin HEAD:refs/heads/land/' .claude/CLOUD.md",
    'cat > f <<EOF\ngit push origin HEAD:land/x\nEOF',
    'ls # git push origin HEAD:land/x',
    'git push origin --delete land/x',
    'git push origin :refs/heads/land/x',
    'git push origin HEAD:refs/heads/feature',
    'git push -u origin worktree-foo',
    'git log --oneline',
  ]) {
    assert.deepEqual(landPushTargets(cmd), [], cmd);
  }
});

test('parser: directory context, multiple refspecs and earlier HEAD moves', () => {
  const [p1] = parsePushCommand('cd /w/one && git push origin HEAD:land/a');
  assert.equal(p1.cdDir, '/w/one');
  const [p2] = parsePushCommand('git -C ../wt -c push.default=simple push origin HEAD:land/a');
  assert.deepEqual(p2.gitC, ['../wt']);
  assert.equal(landPushTargets('git push origin HEAD:land/a main:land/b').length, 2);
  assert.equal(parsePushCommand('git add -A && git commit -qm x && git push origin HEAD:land/a')[0].headMovedBefore, true);
  assert.equal(parsePushCommand('git status && git push origin HEAD:land/a')[0].headMovedBefore, false);
});

// ── rebase preview, each verdict checked against the real land-rebase.sh ───
test('preview: a linear branch rebases clean', () => {
  const d = baseRepo();
  sh(d, 'git checkout -qb feat && echo two >> g.txt && git commit -qam feat && git checkout -q main && echo z > h.txt && git add h.txt && git commit -qm main2');
  assert.equal(assertParity(d, 'feat').status, 'clean');
});

test('preview: a conflict resolved inside a merge of main comes back (the BRO-4558 refusal)', () => {
  const d = baseRepo();
  sh(d, 'git checkout -qb feat && perl -pi -e "s/^c$/FEAT/" f.txt && git commit -qam feat-edit');
  sh(d, 'git checkout -q main && perl -pi -e "s/^c$/MAIN/" f.txt && git commit -qam main-edit');
  sh(d, 'git checkout -q feat && (git merge -q main || true) && printf "a\\nb\\nBOTH\\nd\\ne\\n" > f.txt && git add f.txt && git commit -qm "merge main, resolved"');
  const p = assertParity(d, 'feat');
  assert.equal(p.status, 'conflict');
  assert.match(p.commit, /feat-edit/);
  assert.deepEqual(p.files, ['f.txt']);
  assert.match(blockMessage({ target: 'land/feat', rebase: p, base: 'origin/main' }), /conflicts at commit ".*feat-edit" in f\.txt[\s\S]*reset --soft origin\/main[\s\S]*not a land refusal/);
});

test('preview: a clean merge of main (no false positive)', () => {
  const d = baseRepo();
  sh(d, 'git checkout -qb feat && echo two >> g.txt && git commit -qam feat');
  sh(d, 'git checkout -q main && perl -pi -e "s/^c$/MAIN/" f.txt && git commit -qam main-edit');
  sh(d, 'git checkout -q feat && git merge -q --no-edit main && echo three >> g.txt && git commit -qam after-merge');
  assert.equal(assertParity(d, 'feat').status, 'clean');
});

test('preview: commits already on main are dropped, not replayed; tip == main is clean', () => {
  const d = baseRepo();
  sh(d, 'git checkout -qb feat && perl -pi -e "s/^c$/X/" f.txt && git commit -qam dup && echo n >> g.txt && git commit -qam own');
  sh(d, 'git checkout -q main && git cherry-pick feat~1 >/dev/null && perl -pi -e "s/^X$/Y/" f.txt && git commit -qam later');
  assert.equal(assertParity(d, 'feat').status, 'clean');
  assert.equal(previewRebase({ base: 'main', tip: 'main', cwd: d }).status, 'clean');
});

test('preview: no shared history (shallow boundary) is a skip, never a block', () => {
  const d = baseRepo();
  sh(d, 'git checkout -q --orphan other && git rm -rqf . && echo x > x.txt && git add x.txt && git commit -qm other');
  const p = previewRebase({ base: 'main', tip: 'other', cwd: d });
  assert.equal(p.status, 'skip');
  assert.match(p.reason, /merge-base/);
  assert.equal(previewRebase({ base: 'main', tip: 'nope', cwd: d }).status, 'skip');
});

// ── test registration (branch-scoped) ──────────────────────────────────────
function auditRepo() {
  const d = baseRepo();
  for (const f of ['scripts/audit-orphan-tests.js', 'scripts/lib/orphan-test-gate.js', 'scripts/lib/test-manifest.js']) {
    write(d, f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
  write(d, '.github/workflows/test.yml', 'name: t\n');
  write(d, 'scripts/tests/.gitkeep', ''); // the audit scans this dir unconditionally
  write(d, 'tests/unit/old.test.mjs', '');
  write(d, 'tests/unit/gone.test.mjs', '');
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/gone.test.mjs\ntests/unit/old.test.mjs\n');
  write(d, 'tests/unit/preexisting-orphan.test.mjs', ''); // someone else's red, already on main
  sh(d, 'git add -A && git commit -qm tests && git checkout -qb feat');
  return d;
}

test('tests: a new unregistered test and a deleted-but-listed test block; a pre-existing orphan does not', () => {
  const d = auditRepo();
  write(d, 'tests/unit/new.test.mjs', '');
  sh(d, 'git rm -q tests/unit/gone.test.mjs && git add -A && git commit -qm feat');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'fail');
  assert.equal(r.problems.length, 2, r.problems.join('\n'));
  assert.match(r.problems.join('\n'), /tests\/unit\/new\.test\.mjs is not listed/);
  assert.match(r.problems.join('\n'), /still lists tests\/unit\/gone\.test\.mjs/);
  assert.doesNotMatch(r.problems.join('\n'), /preexisting-orphan/);
});

test('tests: registering both fixes it; a branch with no test changes is clean', () => {
  const d = auditRepo();
  write(d, 'tests/unit/new.test.mjs', '');
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/new.test.mjs\ntests/unit/old.test.mjs\n');
  sh(d, 'git rm -q tests/unit/gone.test.mjs && git add -A && git commit -qm feat');
  assert.equal(checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d }).status, 'clean');
  const e = auditRepo();
  sh(e, 'echo x >> g.txt && git commit -qam feat');
  assert.equal(checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: e }).status, 'clean');
});

// ── hook, end to end, pushing from a git worktree like a real session ──────
function landFixture() {
  const origin = tmp();
  // receive-pack runs auto-maintenance in the bare origin; global config is nulled here (BRO-4749).
  sh(origin, 'git init -q --bare -b main . && git config gc.auto 0 && git config gc.autoDetach false && git config maintenance.auto false && git config receive.autogc false');
  const d = baseRepo();
  sh(d, `git remote add origin "${origin}" && git push -q origin main`);
  const wt = path.join(d, '.claude', 'worktrees', 'w');
  sh(d, `git worktree add -q -b feat "${wt}" main`);
  sh(wt, 'perl -pi -e "s/^c$/FEAT/" f.txt && git commit -qam feat-edit');
  sh(d, 'perl -pi -e "s/^c$/MAIN/" f.txt && git commit -qam main-edit && git push -q origin main');
  sh(wt, 'git fetch -q origin && (git merge -q origin/main || true) && printf "a\\nb\\nBOTH\\nd\\ne\\n" > f.txt && git add f.txt && git commit -qm resolved');
  return { d, wt };
}
function hook(command, cwd, extraEnv = {}) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
  return spawnSync('bash', [HOOK], { input, cwd, env: { ...ENV, ...extraEnv }, encoding: 'utf8' });
}

test('hook: blocks a conflicting land push from a worktree, allows others, honours the bypass, logs', () => {
  const { d, wt } = landFixture();
  const blocked = hook('git push origin HEAD:refs/heads/land/feat', wt);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /LAND PREFLIGHT[\s\S]*feat-edit[\s\S]*f\.txt/);
  assert.equal(hook('git push -u origin feat', wt).status, 0);
  assert.equal(hook('git commit -m "x" && git push origin HEAD:land/feat', wt).status, 0, 'HEAD moves first: skip');
  assert.equal(hook('git push origin HEAD:land/feat  # NO-LAND-PREFLIGHT: verified by hand, rebase is fine', wt).status, 0);
  assert.equal(hook('git push origin HEAD:land/feat', wt, { LAND_PREFLIGHT_DISABLE: '1' }).status, 0);
  // cwd elsewhere, push dir via cd: still judged against the worktree
  assert.equal(hook(`cd "${wt}" && git push origin HEAD:land/feat`, os.tmpdir()).status, 2);
  const log = fs.readFileSync(path.join(d, '.claude', 'land-preflight.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.event === 'block' && e.target === 'land/feat'));
  assert.ok(log.some((e) => e.event === 'bypass'));
  assert.ok(log.some((e) => e.event === 'skip'));
});

test('hook: a squashed branch passes; a non-repo cwd and garbage input fail open', () => {
  const { wt } = landFixture();
  sh(wt, 'git reset -q --soft origin/main && git commit -qm squashed');
  const r = hook('git push origin HEAD:refs/heads/land/feat', wt);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hook('git push origin HEAD:land/x', os.tmpdir()).status, 0);
  const g = spawnSync('bash', [HOOK], { input: 'not json push land/', env: ENV, encoding: 'utf8' });
  assert.equal(g.status, 0);
  assert.equal(runHook({ command: 'git status', cwd: wt }).decision, 'skip');
});

test('tests: an audit that crashes (exit 1, no JSON) skips instead of blocking with garbage', () => {
  const d = auditRepo();
  write(d, 'scripts/audit-orphan-tests.js', "throw new Error('boom');\n");
  write(d, 'tests/unit/new.test.mjs', '');
  sh(d, 'git add -A && git commit -qm feat');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'skip', JSON.stringify(r));
});

test('parser: pushes into a repo the parser cannot locate are marked dirUnknown; -df is a delete; subshell cd is scoped', () => {
  const one = (c) => parsePushCommand(c)[0];
  for (const c of [
    'pushd ../app && git push origin HEAD:land/x',
    'git --git-dir=../app/.git push origin HEAD:land/x',
    'git --work-tree ../app push origin HEAD:land/x',
    'GIT_DIR=../app/.git git push origin HEAD:land/x',
    'cd && git push origin HEAD:land/x',
    'cd ~/app && git push origin HEAD:land/x',
    'cd "$REPO" && git push origin HEAD:land/x',
  ]) assert.equal(one(c).dirUnknown, true, c);
  assert.equal(one('cd /abs/repo && git push origin HEAD:land/x').dirUnknown, false);
  assert.equal(one('cd /abs/repo && git push origin HEAD:land/x').cdDir, '/abs/repo');
  assert.equal(one('(cd /elsewhere && make) && git push origin HEAD:land/x').cdDir, null, 'subshell cd does not leak');
  assert.deepEqual(landPushTargets('git push -df origin land/x'), []);
  assert.deepEqual(landPushTargets('git push -fd origin land/x'), []);
  assert.equal(landPushTargets('git push -f origin HEAD:land/x').length, 1);
});

test('hook: an unknown push dir or a non-origin remote is a skip, never judged against the session cwd', () => {
  const { wt } = landFixture(); // wt conflicts with main, so judging it would block
  assert.equal(runHook({ command: 'pushd /tmp && git push origin HEAD:land/feat', cwd: wt }).decision, 'skip');
  assert.equal(runHook({ command: 'git --git-dir=/tmp/x/.git push origin HEAD:land/feat', cwd: wt }).decision, 'skip');
  assert.equal(runHook({ command: 'git push fork HEAD:land/feat', cwd: wt }).decision, 'skip');
  assert.equal(runHook({ command: 'git push origin HEAD:land/feat', cwd: wt }).decision, 'block', 'control');
});

test('tests: manifest problems the audit reports (unsorted manifest) block too', () => {
  const d = auditRepo();
  write(d, 'tests/unit/new.test.mjs', '');
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/old.test.mjs\ntests/unit/new.test.mjs\ntests/unit/gone.test.mjs\n');
  sh(d, 'git add -A && git commit -qm feat');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'fail', JSON.stringify(r));
  assert.match(r.problems.join('\n'), /unit-test-manifest\.txt: .*test-manifest\.js --fix/);
});

test('cli: a block exits 3 (distinct from a load crash, which exits 1)', () => {
  const { wt } = landFixture();
  const r = spawnSync('node', [path.join(ROOT, 'scripts/lib/land-preflight.mjs'), '--cwd', wt, '--tip', 'HEAD', '--base', 'origin/main', '--no-fetch', '--no-tests'], { env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  sh(wt, 'git reset -q --soft origin/main && git commit -qm squashed');
  const c = spawnSync('node', [path.join(ROOT, 'scripts/lib/land-preflight.mjs'), '--cwd', wt, '--tip', 'HEAD', '--base', 'origin/main', '--no-fetch', '--no-tests'], { env: ENV, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
});

test('hook wrapper: runs (and still blocks) with no `timeout` on PATH, like stock macOS', () => {
  const { wt } = landFixture();
  const bin = tmp();
  for (const b of ['node', 'git', 'bash', 'cat', 'dirname']) {
    const p = spawnSync('bash', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(p, path.join(bin, b));
  }
  const r = hook('git push origin HEAD:refs/heads/land/feat', wt, { PATH: bin });
  assert.equal(r.status, 2, r.stderr);
});

test('bot-owned rewrite: a squash over a failed merge (reverting main\'s bot data) blocks; a small data edit does not (BRO-4956)', async () => {
  const { checkBotOwnedRewrite, judgeLand } = await import('../../scripts/lib/land-preflight.mjs');
  const d = baseRepo();
  // main gains 12 bot-owned files after the branch point
  sh(d, 'git checkout -qb feat main~0 && git checkout -q main');
  for (let i = 0; i < 12; i++) write(d, `data/audit/a${i}.json`, `{"v":${i}}\n`);
  sh(d, 'git add -A && git commit -qm bots');
  // the broken squash: tree of the old branch point committed on top of main
  sh(d, 'git checkout -q feat && echo fix >> g.txt && git commit -qam fix && git reset -q --soft main && git commit -qm squash');
  const bad = checkBotOwnedRewrite({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.count, 12);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.decision, 'block');
  assert.match(v.message, /bot-owned data files/);
  // a deliberate edit of one audit file is fine
  sh(d, 'git checkout -qB ok main && echo \'{"v":99}\' > data/audit/a1.json && git commit -qam one');
  assert.equal(checkBotOwnedRewrite({ base: 'main', tip: 'HEAD', cwd: d }).status, 'pass');
});
