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
import collection from '../../scripts/lib/unit-test-collection.js';
import { MIN_EXPECTED_WORKFLOWS } from '../../scripts/lib/workflow-glob-guard.js';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';
const HEADER = collection.RETIRED_HEADER.join('\n') + '\n';

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
function auditRepo({ collector = false } = {}) {
  const d = baseRepo();
  // BRO-2483: a tree carrying the collector reads its node batch from it.
  if (collector) write(d, 'scripts/lib/unit-test-collection.js', fs.readFileSync(path.join(ROOT, 'scripts/lib/unit-test-collection.js'), 'utf8'));
  // ci-test-coverage.js + bash-integration-test-list.js: the audit's coverage rule (BRO-2778).
  for (const f of ['scripts/audit-orphan-tests.js', 'scripts/lib/orphan-test-gate.js', 'scripts/lib/recheck-probe-guard.js', 'scripts/lib/test-manifest.js', 'scripts/lib/ci-test-coverage.js', 'scripts/lib/bash-integration-test-list.js', 'scripts/lib/workflow-glob-guard.js', 'scripts/lib/scan-alert-ledger-gaps.js']) {
    write(d, f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
  write(d, '.github/workflows/test.yml', 'name: t\n');
  // Keep the real audit and its dependency chain in this isolated repo. Inert
  // workflows satisfy its inventory floor without registering any tests.
  for (let i = 1; i < MIN_EXPECTED_WORKFLOWS; i++) {
    write(d, `.github/workflows/padding-${i}.yml`, 'jobs: {}\n');
  }
  write(d, '.gitattributes', 'tests/unit-test-manifest.txt merge=union\n'); // as in the real repo
  write(d, 'scripts/tests/.gitkeep', ''); // the audit scans this dir unconditionally
  write(d, 'tests/unit/old.test.mjs', '');
  write(d, 'tests/unit/gone.test.mjs', '');
  // A collector tree carries the RETIRED header (BRO-2483); its list lines are ignored.
  write(d, 'tests/unit-test-manifest.txt', `${collector ? HEADER : ''}tests/unit/gone.test.mjs\ntests/unit/old.test.mjs\n`);
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
  assert.match(r.problems.join('\n'), /tests\/unit\/new\.test\.mjs runs in no CI job/);
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

// ── BRO-2483: collector tree — no registration step, manifest edits only warn ──
test('tests (collector tree): a new tests/unit file needs no registration; a tombstone line for a deleted file is not a problem', () => {
  const d = auditRepo({ collector: true });
  write(d, 'tests/unit/new.test.mjs', '');
  sh(d, 'git rm -q tests/unit/gone.test.mjs && git add -A && git commit -qm feat');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'clean', (r.problems || []).join('\n'));
});

test('tests (collector tree): a default-excluded scripts/verify-* probe with no run: step or exemption still blocks', () => {
  const d = auditRepo({ collector: true });
  write(d, 'scripts/verify-something-live.test.mjs', '');
  sh(d, 'git add -A && git commit -qm feat');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'fail');
  assert.match(r.problems.join('\n'), /verify-something-live\.test\.mjs runs in no CI job: scripts\/lib\/unit-test-collection\.js does not collect it/);
});

test('collector tree: any edit to the retired manifest only WARNS ("ignored: nothing reads this file"), never blocks', async () => {
  const { judgeLand, retiredManifestWarnings } = await import('../../scripts/lib/land-preflight.mjs');
  const d = auditRepo({ collector: true });
  // The old habit: register a new test with an (unsorted) list line.
  write(d, 'tests/unit-test-manifest.txt', `${HEADER}tests/unit/gone.test.mjs\ntests/unit/old.test.mjs\ntests/unit/aaa-new.test.mjs\n`);
  write(d, 'tests/unit/aaa-new.test.mjs', '');
  sh(d, 'git add -A && git commit -qm "old habit: register in the manifest"');
  const w = retiredManifestWarnings({ base: 'main', src: 'HEAD', cwd: d });
  assert.equal(w.length, 1);
  assert.match(w[0], /tests\/unit-test-manifest\.txt is retired \(BRO-2483\): this edit is ignored: nothing reads this file; new tests need no registration/);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false });
  assert.equal(v.decision, 'allow', v.message);
  assert.deepEqual(v.warnings, w);
  assert.equal(v.detail.tests.status, 'clean', JSON.stringify(v.detail.tests));
  assert.equal(v.detail.manifests.status, 'pass', JSON.stringify(v.detail.manifests));
  // The CLI prints the warning and still exits 0.
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/lib/land-preflight.mjs'), '--tip', 'HEAD', '--base', 'main', '--no-fetch', '--cwd', d], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /land preflight warning: tests\/unit-test-manifest\.txt is retired/);
  // Without the collector (a pre-BRO-2483 tree) the same edit warns nothing.
  const e = auditRepo();
  write(e, 'tests/unit-test-manifest.txt', 'tests/unit/gone.test.mjs\ntests/unit/new.test.mjs\ntests/unit/old.test.mjs\n');
  write(e, 'tests/unit/new.test.mjs', '');
  sh(e, 'git add -A && git commit -qm feat');
  assert.deepEqual(retiredManifestWarnings({ base: 'main', src: 'HEAD', cwd: e }), []);
});

// A branch cut BEFORE BRO-2483, judged after main gained the collector: the
// advice must describe the tree that will land, never "edit the manifest".
function predatingBranch() {
  const d = auditRepo(); // pre-BRO-2483 tree, on branch feat
  sh(d, 'git checkout -q main');
  write(d, 'scripts/lib/unit-test-collection.js', fs.readFileSync(path.join(ROOT, 'scripts/lib/unit-test-collection.js'), 'utf8'));
  write(d, 'tests/unit-test-manifest.txt', `${HEADER}tests/unit/gone.test.mjs\ntests/unit/old.test.mjs\n`); // header prepended, list frozen
  sh(d, 'git add -A && git commit -qm "BRO-2483 lands on main" && git checkout -q feat');
  return d;
}

test('predating branch: a new test with no manifest edit is clean, with "merge origin/main first" advice, never "edit the manifest"', async () => {
  const { judgeLand } = await import('../../scripts/lib/land-preflight.mjs');
  const d = predatingBranch();
  write(d, 'tests/unit/new.test.mjs', '');
  sh(d, 'git add -A && git commit -qm feat');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'clean', JSON.stringify(r));
  assert.match(r.warnings.join('\n'), /this branch predates BRO-2483: merge origin\/main first|this branch predates BRO-2483 \(main collects/);
  assert.match(r.warnings.join('\n'), /do not edit it; new tests need no registration/);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false });
  assert.equal(v.decision, 'allow', v.message);
  assert.doesNotMatch(JSON.stringify(v), /add it to tests\/unit-test-manifest/);
});

test('predating branch: editing the old manifest only warns; the land rebase is clean and keeps the header on top', async () => {
  const { judgeLand } = await import('../../scripts/lib/land-preflight.mjs');
  const d = predatingBranch();
  write(d, 'tests/unit/new.test.mjs', '');
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/gone.test.mjs\ntests/unit/new.test.mjs\ntests/unit/old.test.mjs\n');
  sh(d, 'git add -A && git commit -qm "register the old way"');
  const p = previewRebase({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(p.status, 'clean', JSON.stringify(p));
  const merged = sh(d, `git show ${p.tip}:tests/unit-test-manifest.txt`);
  assert.ok(collection.hasRetiredHeader(merged), 'the union merge keeps the RETIRED header on top');
  assert.match(merged, /tests\/unit\/new\.test\.mjs/, 'the in-flight line merges into the ignored list');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d, landedTip: p.tip });
  assert.equal(r.status, 'clean', JSON.stringify(r));
  assert.match(r.warnings.join('\n'), /this branch predates BRO-2483/);
  assert.match(r.warnings.join('\n'), /edit to tests\/unit-test-manifest\.txt is ignored: nothing reads that file/);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false });
  assert.equal(v.decision, 'allow', v.message);
  assert.equal(v.detail.manifests.status, 'pass', JSON.stringify(v.detail.manifests));
  assert.doesNotMatch(JSON.stringify(v), /add it to tests\/unit-test-manifest/);
});

test('predating branch: the landed tree is still judged — a deleted file left in its tsx manifest blocks', () => {
  const d = auditRepo();
  sh(d, 'git checkout -q main');
  write(d, 'scripts/lib/unit-test-collection.js', fs.readFileSync(path.join(ROOT, 'scripts/lib/unit-test-collection.js'), 'utf8'));
  write(d, 'tests/unit-test-manifest.txt', `${HEADER}tests/unit/gone.test.mjs\ntests/unit/old.test.mjs\n`);
  write(d, 'tests/unit-test-manifest-tsx.txt', 'tests/unit/old.test.mjs\n'); // only main's tree lists it
  sh(d, 'git add -A && git commit -qm "BRO-2483 lands on main" && git checkout -q feat');
  sh(d, 'git rm -q tests/unit/old.test.mjs && git commit -qm "drop old"');
  const p = previewRebase({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(p.status, 'clean');
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d, landedTip: p.tip });
  assert.equal(r.status, 'fail', JSON.stringify(r));
  assert.match(r.problems.join('\n'), /tests\/unit-test-manifest-tsx\.txt still lists tests\/unit\/old\.test\.mjs/);
  assert.match(r.warnings.join('\n'), /this branch predates BRO-2483/);
});

test('collector tree: deleting a file still named in EXCLUDED blocks (stale-list check against the deleted set)', () => {
  const d = auditRepo({ collector: true });
  const excludedRel = 'tests/unit/dmarc-deliverability.test.mjs'; // a real EXCLUDED entry
  sh(d, 'git checkout -q main');
  write(d, excludedRel, '');
  sh(d, 'git add -A && git commit -qm "add excluded test" && git checkout -q feat && git merge -q main');
  sh(d, `git rm -q ${excludedRel} && git commit -qm "delete it"`);
  const r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'fail', JSON.stringify(r));
  assert.match(r.problems.join('\n'), /unit-test-collection\.js EXCLUDED still lists tests\/unit\/dmarc-deliverability\.test\.mjs, which this branch deletes/);
});

test('collector edit: tests it newly drops from the node batch block unless EXCLUDED with a reason or run by a workflow step', () => {
  const COL = 'scripts/lib/unit-test-collection.js';
  const d = auditRepo({ collector: true });
  const src = fs.readFileSync(path.join(d, COL), 'utf8');
  assert.ok(src.includes("const NODE_TEST_DIRS = ['tests/unit', "));
  write(d, COL, src.replace("const NODE_TEST_DIRS = ['tests/unit', ", 'const NODE_TEST_DIRS = ['));
  write(d, 'scripts/kept.test.mjs', ''); // keeps the collection non-empty (an empty one is a COLLECTOR FAILURE)
  sh(d, 'git add -A && git commit -qm "stop collecting tests/unit"');
  let r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'fail', JSON.stringify(r));
  const text = r.problems.join('\n');
  assert.match(text, /tests\/unit\/old\.test\.mjs no longer runs in the node batch after this edit/);
  // The audit judges the newly excluded files too, even though the push never touched them.
  assert.match(text, /tests\/unit\/old\.test\.mjs runs in no CI job/);

  // Excluding ONE file with a reason and giving it a run: step is fine.
  const e = auditRepo({ collector: true });
  const esrc = fs.readFileSync(path.join(e, COL), 'utf8');
  write(e, COL, esrc.replace('const EXCLUDED = new Map([\n', "const EXCLUDED = new Map([\n  ['tests/unit/old.test.mjs', 'runs at its own step'],\n"));
  write(e, '.github/workflows/test.yml', 'name: t\njobs:\n  t:\n    steps:\n      - name: old\n        run: node --test tests/unit/old.test.mjs\n');
  sh(e, 'git commit -qam "exclude old, run it at its own step"');
  r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: e });
  assert.equal(r.status, 'clean', JSON.stringify(r));
  // ...but without the run: step it runs nowhere, and the scoped audit blocks it.
  write(e, '.github/workflows/test.yml', 'name: t\n');
  sh(e, 'git commit -qam "lose the step"');
  r = checkTestRegistration({ base: 'main', tip: 'HEAD', cwd: e });
  assert.equal(r.status, 'fail', JSON.stringify(r));
  assert.match(r.problems.join('\n'), /tests\/unit\/old\.test\.mjs runs in no CI job/);
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
  return spawnSyncStdinFile('bash', [HOOK], { input, cwd, env: { ...ENV, ...extraEnv }, encoding: 'utf8' });
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
  const g = spawnSyncStdinFile('bash', [HOOK], { input: 'not json push land/', env: ENV, encoding: 'utf8' });
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
  // BRO-5086: the stale-tree check names the older main state; it supersedes the bot-owned recipe.
  assert.match(v.message, /reverts 12 of the 13 files it changes to an older main state/);
  // a deliberate edit of one audit file is fine
  sh(d, 'git checkout -qB ok main && echo \'{"v":99}\' > data/audit/a1.json && git commit -qam one');
  assert.equal(checkBotOwnedRewrite({ base: 'main', tip: 'HEAD', cwd: d }).status, 'pass');
});

// BRO-5086: the general stale-tree squash. main gains edits to ordinary files
// after the branch point; `git reset --soft main` without merging first makes
// one commit that reverts them all. Bot-owned paths are not involved, so only
// checkStaleRevert can see it.
function staleSquashRepo() {
  const d = baseRepo();
  for (let i = 0; i < 4; i++) write(d, `src/m${i}.ts`, `export const v = 0;\n`);
  sh(d, 'git add -A && git commit -qm "more files"');
  sh(d, 'git branch feat');
  for (let i = 0; i < 4; i++) write(d, `src/m${i}.ts`, `export const v = ${i + 1};\n`);
  write(d, 'src/new.ts', 'export {};\n');
  sh(d, 'git add -A && git commit -qm "main moves on"');
  return d;
}

test('stale-tree squash: reverting main\'s newer edits to ordinary files blocks (BRO-5086)', async () => {
  const { judgeLand, checkStaleRevert } = await import('../../scripts/lib/land-preflight.mjs');
  const d = staleSquashRepo();
  sh(d, 'git checkout -q feat && echo fix >> g.txt && git commit -qam fix && git reset -q --soft main && git commit -qm squash');
  const s = checkStaleRevert({ base: 'main', tip: 'HEAD', cwd: d });
  assert.equal(s.status, 'fail', JSON.stringify(s));
  assert.equal(s.count, 5); // 4 edits + 1 add reverted; g.txt is the branch's own change
  assert.equal(s.of, 6);
  assert.match(s.matches, /more files/);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.decision, 'block');
  assert.match(v.message, /reverts 5 of the 6 files/);
  assert.match(v.message, /merging origin\/main/);
});

test('stale-tree check passes a correct squash, a branch merely behind main, and a branch deleting old files (BRO-5086)', async () => {
  const { judgeLand } = await import('../../scripts/lib/land-preflight.mjs');
  const d = staleSquashRepo();
  // behind main, unmerged: land rebases it, so nothing is reverted
  sh(d, 'git checkout -q feat && echo fix >> g.txt && git commit -qam fix');
  let v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.decision, 'allow', v.message);
  assert.equal(v.detail.staleRevert.status, 'pass');
  // the right squash: merge main first
  sh(d, 'git merge -q --no-edit main && git reset -q --soft main && git commit -qm squash');
  v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.decision, 'allow', v.message);
  // deleting files that have existed for a while is not a revert
  sh(d, 'git checkout -qB del main && git rm -q src/m0.ts src/m1.ts src/m2.ts src/m3.ts f.txt && git commit -qm "delete old files"');
  v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.decision, 'allow', v.message);
});

test('manifest left unsorted on the rebased tree blocks; a sorted one passes (BRO-5086)', async () => {
  const { judgeLand } = await import('../../scripts/lib/land-preflight.mjs');
  const d = baseRepo();
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/a.test.mjs\ntests/unit/m.test.mjs\n');
  sh(d, 'git add -A && git commit -qm manifest && git branch feat');
  sh(d, 'echo more >> g.txt && git commit -qam "main moves on"');
  sh(d, 'git checkout -q feat');
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/a.test.mjs\ntests/unit/m.test.mjs\ntests/unit/b.test.mjs\n');
  sh(d, 'git commit -qam "branch appends b"');
  let v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.detail.manifests.status, 'fail', JSON.stringify(v.detail.manifests));
  assert.equal(v.decision, 'block');
  assert.match(v.message, /unit-test-manifest\.txt is not sorted \(first out of place: tests\/unit\/m\.test\.mjs\) after the land rebase/);
  write(d, 'tests/unit-test-manifest.txt', 'tests/unit/a.test.mjs\ntests/unit/b.test.mjs\ntests/unit/m.test.mjs\n');
  sh(d, 'git commit -qam sort');
  v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.detail.manifests.status, 'pass');
  assert.equal(v.decision, 'allow', v.message);
});

// BRO-4909: a push touching .github/workflows runs the workflow lints and the
// DEPENDENCIES.md freshness check on the landing tree; others never pay for it.
test('workflow checks: run only when workflows change, block on exit 1, fail open on anything else (BRO-4909)', async () => {
  const { checkWorkflowChecks, judgeLand, blockMessage, WORKFLOW_CHECKS, WORKFLOW_PATH_RE } = await import('../../scripts/lib/land-preflight.mjs');
  const d = baseRepo();
  write(d, 'scripts/lint-workflow-guards.sh', '#!/bin/sh\n');
  write(d, 'scripts/audit-workflow-hygiene.js', '\n');
  write(d, 'scripts/generate-workflow-dependencies.js', '\n');
  write(d, 'scripts/audit-push-retry-budgets.js', '\n');
  write(d, 'tests/unit/audit-push-retry-budgets-residual.test.mjs', '\n');
  // BRO-5120: every listed check's file exists in the fixture, so the batch runs all of them
  for (const c of WORKFLOW_CHECKS) write(d, c.file || c.args[0], '\n');
  write(d, '.github/workflows/a.yml', 'name: a\n');
  sh(d, 'git add -A && git commit -qm wf && git checkout -qb feat');
  const calls = [];
  // The checks run as one concurrent bash batch; the stub plays that batch by
  // writing the <i>.rc / <i>.out files the script names (rc taken per check index).
  const stub = (rcs) => (cmd, args) => {
    calls.push(args[1]);
    const callNo = calls.length;
    const dirs = [...args[1].matchAll(/>"([^"]+)\/(\d+)\.out"/g)];
    for (const [, dir, i] of dirs) {
      fs.writeFileSync(path.join(dir, `${i}.out`), 'DEPENDENCIES.md is stale\n');
      fs.writeFileSync(path.join(dir, `${i}.rc`), `${typeof rcs === 'function' ? rcs(Number(i), callNo) : rcs}\n`);
    }
    return { status: 0 };
  };
  // unrelated change: nothing runs
  write(d, 'g2.txt', 'x\n');
  sh(d, 'git add -A && git commit -qm unrelated');
  assert.equal(checkWorkflowChecks({ base: 'main', tip: 'HEAD', cwd: d, run: stub(1) }).status, 'clean');
  assert.equal(calls.length, 0);
  // workflow change: all three checks run on the landing tree
  write(d, '.github/workflows/a.yml', 'name: b\n');
  sh(d, 'git commit -qam wfchange');
  assert.equal(checkWorkflowChecks({ base: 'main', tip: 'HEAD', cwd: d, run: stub(0) }).status, 'clean');
  assert.equal(calls.length, 1);
  for (const c of WORKFLOW_CHECKS) assert.ok(calls[0].includes(c.file || c.args[0]), `batch runs ${c.file || c.args[0]}`);
  // exit 1 blocks and the message names the fix
  // red on the landing tree, green on base: this branch broke it
  calls.length = 0;
  const bad = checkWorkflowChecks({ base: 'main', tip: 'HEAD', cwd: d, run: stub((i, call) => (call === 1 ? 1 : 0)) });
  assert.equal(bad.status, 'fail');
  assert.equal(calls.length, 2, 'failed checks are re-run on base');
  // red on base too: not this branch's fault, never blocks
  assert.equal(checkWorkflowChecks({ base: 'main', tip: 'HEAD', cwd: d, run: stub(1) }).status, 'clean');
  // BRO-5833: the job-timeout budget gates are part of the batch
  assert.ok(WORKFLOW_CHECKS.some((c) => c.args.includes('--fail-on-job-timeout')) && WORKFLOW_CHECKS.some((c) => c.file === 'tests/unit/audit-push-retry-budgets-residual.test.mjs'));
  assert.ok(WORKFLOW_PATH_RE.test('scripts/lib/audit-push-retry-budgets.js'));
  assert.ok(WORKFLOW_PATH_RE.test('.github/actions/x/action.yml') && WORKFLOW_PATH_RE.test('scripts/lib/push-with-retry.sh'));
  assert.match(blockMessage({ target: 'land/x', base: 'main', workflows: bad }), /generate-workflow-dependencies\.js --check fails on the landing tree/);
  // a check that crashes (exit 2) or times out never blocks
  assert.equal(checkWorkflowChecks({ base: 'main', tip: 'HEAD', cwd: d, run: stub(124) }).status, 'clean');
  assert.equal(checkWorkflowChecks({ base: 'main', tip: 'HEAD', cwd: d, run: () => ({ error: new Error('ETIMEDOUT'), status: null }) }).status, 'clean'); // no rc files written
  // judgeLand wires it in: a failing check blocks the land push
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false, seams: { checkWorkflowChecks: () => bad } });
  assert.equal(v.decision, 'block');
  assert.match(v.message, /Workflow checks \(CI would go red/);
});

// BRO-5520: two session plans over the action cap reached land.yml, which
// refused the first about 40 minutes later; the push hook now says so up front.
test('pending plans: a branch adding a pending bro-* plan over the cap blocks; within the cap, applied, numbered, or only on main does not (BRO-5520)', async () => {
  const { checkPendingPlans, judgeLand } = await import('../../scripts/lib/land-preflight.mjs');
  const { MAX_PLAN_ACTIONS } = (await import('../../scripts/lib/pending-fix-limits.js')).default;
  const planJson = (n, status = 'pending') => JSON.stringify({
    issueNumber: 'bro-1', planId: 'p-1', status,
    plan: { actions: Array.from({ length: n }, () => ({ type: 'data-edit', file: 'shows.json', showSlug: 's', field: 'title', oldValue: null, newValue: 'x' })) },
  }, null, 2) + '\n';
  const check = (extra = {}) => checkPendingPlans({ base: 'main', tip: 'HEAD', cwd: d, ...extra });
  const d = baseRepo();
  // Already on main: land judges new failures only, so it is not this branch's to fix.
  write(d, 'data/pending-fixes/bro-0.json', planJson(MAX_PLAN_ACTIONS + 5));
  sh(d, 'git add -A && git commit -qm "plan on main" && git checkout -qb feat && echo two > g.txt && git commit -qam other');
  assert.equal(check().status, 'clean');
  // Numbered plans are the feedback pipeline's, outside the land test's scope.
  write(d, 'data/pending-fixes/925.json', planJson(MAX_PLAN_ACTIONS + 1));
  sh(d, 'git add -A && git commit -qm numbered');
  assert.equal(check().status, 'clean');
  write(d, 'data/pending-fixes/bro-1.json', planJson(MAX_PLAN_ACTIONS));
  sh(d, 'git add -A && git commit -qm plan');
  assert.equal(check().status, 'pass');
  const fits = sh(d, 'git rev-parse HEAD');
  write(d, 'data/pending-fixes/bro-1.json', planJson(MAX_PLAN_ACTIONS + 1));
  sh(d, 'git commit -qam bigger');
  const bad = check();
  assert.equal(bad.status, 'fail');
  assert.deepEqual(bad.problems, [`data/pending-fixes/bro-1.json: ${MAX_PLAN_ACTIONS + 1} actions (max ${MAX_PLAN_ACTIONS}); split it into bro-1-b.json`]);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false });
  assert.equal(v.decision, 'block');
  assert.match(v.message, /Pending data plans \(execute-approved-fix\.js refuses these at apply time/);
  assert.match(v.message, /split it into bro-1-b\.json/);
  // The plan is read from the tree land would apply when there is one.
  assert.equal(check({ landedTip: fits }).status, 'pass');
  // Only a CI run finishes a plan, and it commits to main: a branch adding one
  // already applied carries a local executor run, which CI would skip (BRO-5647).
  write(d, 'data/pending-fixes/bro-1.json', planJson(MAX_PLAN_ACTIONS + 1, 'applied'));
  sh(d, 'git commit -qam applied');
  const finished = check();
  assert.equal(finished.status, 'fail');
  assert.match(finished.problems.join('\n'), /bro-1\.json: this branch adds it as "applied"/);
  write(d, 'data/pending-fixes/bro-1.json', planJson(MAX_PLAN_ACTIONS));
  sh(d, 'git commit -qam pending-again');
  assert.equal(check().status, 'pass');
  // A status the executor does not know warns and never blocks (BRO-5015).
  write(d, 'data/pending-fixes/bro-1-b.json', planJson(1, 'approved'));
  sh(d, 'git add -A && git commit -qm typo');
  const typo = check();
  assert.equal(typo.status, 'pass');
  assert.match(typo.warnings.join('\n'), /bro-1-b\.json: status "approved" will not run/);
  // A renamed plan is judged under its new name (--no-renames: delete + add).
  write(d, 'data/pending-fixes/bro-3.json', planJson(MAX_PLAN_ACTIONS + 2));
  sh(d, 'git add -A && git commit -qm three');
  sh(d, 'git mv data/pending-fixes/bro-3.json data/pending-fixes/bro-4.json && git commit -qm rename');
  assert.match(check().problems.join('\n'), /data\/pending-fixes\/bro-4\.json: 27 actions/);
  // A deleted plan has nothing left to apply, even one main carries.
  sh(d, 'git rm -q data/pending-fixes/bro-4.json data/pending-fixes/bro-0.json && git commit -qm gone');
  assert.equal(check().status, 'pass');
  // Plain git diff pairs bro-0's delete with 925.json's add as a rename (similar
  // JSON), and --diff-filter=AM would then drop the add: hence --no-renames.
  assert.match(sh(d, 'git diff --name-status --no-renames main...HEAD -- data/pending-fixes'), /^D\tdata\/pending-fixes\/bro-0\.json$/m);
  // Broken JSON fails the land test's JSON.parse, so it blocks too.
  write(d, 'data/pending-fixes/bro-2.json', '{ "status": "pending", ');
  sh(d, 'git add -A && git commit -qm broken');
  assert.match(check().problems.join('\n'), /bro-2\.json: not valid JSON/);
  // The other checks never depend on the plan checks loading.
  assert.equal(check({ load: () => { throw new Error('boom'); } }).status, 'skip');
});

// BRO-5647: a local preview run of the executor wrote "applied" into a plan that
// then landed, and the CI apply skipped it as done while going green.
test('pending plans: a branch moving a bro-* plan off pending blocks; editing one main already finished does not (BRO-5647)', async () => {
  const { checkPendingPlans } = await import('../../scripts/lib/land-preflight.mjs');
  const planJson = (status, summary = 's') => JSON.stringify({
    issueNumber: 'bro-7', planId: 'p-7', status,
    plan: { summary, actions: [{ type: 'data-edit', file: 'shows.json', showSlug: 's', field: 'title', oldValue: null, newValue: 'x' }] },
  }, null, 2) + '\n';
  const check = () => checkPendingPlans({ base: 'main', tip: 'HEAD', cwd: d });
  const d = baseRepo();
  write(d, 'data/pending-fixes/bro-7.json', planJson('applied'));
  write(d, 'data/pending-fixes/bro-8.json', planJson('pending'));
  sh(d, 'git add -A && git commit -qm "plans on main" && git checkout -qb feat');
  // Main already applied bro-7 in CI: a later wording edit is history.
  write(d, 'data/pending-fixes/bro-7.json', planJson('applied', 'reworded'));
  sh(d, 'git commit -qam reword');
  assert.equal(check().status, 'pass');
  for (const status of ['applied', 'partial', 'rejected', 'validation-failed']) {
    write(d, 'data/pending-fixes/bro-8.json', planJson(status));
    sh(d, `git commit -qam ${status}`);
    const v = check();
    assert.equal(v.status, 'fail', status);
    assert.deepEqual(v.problems.map((p) => p.slice(0, 80)), [`data/pending-fixes/bro-8.json: this branch moves it from "pending" to "${status}", which only`.slice(0, 80)]);
  }
});

// BRO-5657: cloud containers have no pre-push hook, so land.yml was the first to see a
// new top-level script missing from test.yml on.push.paths (one ~45 min land cycle lost).
test('BRO-5657: toplevel push-path check blocks a new uncovered script, names the line, passes once covered', async () => {
  const { checkToplevelPushPaths, judgeLand, TOPLEVEL_PUSH_PATH_RE } = await import('../../scripts/lib/land-preflight.mjs');
  const d = baseRepo();
  write(d, 'scripts/audit-toplevel-script-test-yml-coverage.js', '\n');
  write(d, 'README.md', 'x\n');
  sh(d, 'git add -A && git commit -qm base && git checkout -qb feat');
  // unrelated change: the audit never runs
  write(d, 'g.txt', 'x\n');
  sh(d, 'git add -A && git commit -qm unrelated');
  const never = () => { throw new Error('audit must not run'); };
  assert.equal(checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor: never }).status, 'clean');

  write(d, 'scripts/foo-probe.js', '\n');
  sh(d, 'git add -A && git commit -qm probe');
  const gap = { test: 'tests/unit/foo-probe.test.mjs', testCovered: true, source: 'scripts/foo-probe.js', sourceCovered: false, via: 'require' };
  // new gap vs base -> fail with the exact line to add
  const gapsFor = (root) => (fs.existsSync(path.join(root, 'scripts/foo-probe.js')) ? [gap] : []);
  const bad = checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor });
  assert.equal(bad.status, 'fail');
  assert.match(bad.problems[0], /- 'scripts\/foo-probe\.js'/);
  const v = judgeLand({ cwd: d, src: 'HEAD', target: 'land/x', base: 'main', fetch: false, checkTests: false, seams: { checkToplevelPushPaths: () => bad } });
  assert.equal(v.decision, 'block');
  assert.match(v.message, /Top-level script push paths/);
  assert.match(v.message, /- 'scripts\/foo-probe\.js'/);
  // same branch once covered -> clean
  assert.equal(checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor: () => [] }).status, 'clean');
  // a gap already on base is not this branch's fault
  assert.equal(checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor: () => [gap] }).status, 'clean');
  // audit cannot run -> fail open; so does a base audit that cannot run (cannot tell whose gap it is)
  assert.equal(checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor: () => null }).status, 'skip');
  assert.equal(checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor: (root) => (fs.existsSync(path.join(root, 'scripts/foo-probe.js')) ? [gap] : null) }).status, 'skip');
  // same uncovered source reported under a different test (reordered/renamed) is still base's gap
  assert.equal(checkToplevelPushPaths({ base: 'main', tip: 'HEAD', cwd: d, gapsFor: (root) => [{ ...gap, test: fs.existsSync(path.join(root, 'scripts/foo-probe.js')) ? 'tests/unit/a.test.mjs' : 'tests/unit/b.test.mjs' }] }).status, 'clean');
  // a branch touching only a scripts/lib test or the collector helpers still runs the audit
  assert.ok(TOPLEVEL_PUSH_PATH_RE.test('scripts/lib/foo.test.mjs') && TOPLEVEL_PUSH_PATH_RE.test('scripts/lib/unit-test-collection.js'));
  assert.ok(TOPLEVEL_PUSH_PATH_RE.test('scripts/foo-probe.js') && !TOPLEVEL_PUSH_PATH_RE.test('scripts/lib/x.js'));
});

test('coordinator warning reaches the session as additionalContext on a non-blocking land push (BRO-6083)', () => {
  const origin = tmp();
  sh(origin, 'git init -q --bare -b main . && git config gc.auto 0 && git config receive.autogc false');
  const d = baseRepo();
  sh(d, `git remote add origin "${origin}" && git push -q origin main`);
  // Stand-in for scripts/coordinator-check.js: the hook runs the pushed repo's own copy.
  write(d, 'scripts/coordinator-check.js', 'console.log(JSON.stringify({ status: "warn", message: "COORDINATOR CHECK (advisory): coordinated on BRO-5955" }));\n');
  sh(d, 'git checkout -qb feat && git add -A && git commit -qm coord && git fetch -q origin');
  const r = hook('git push origin HEAD:refs/heads/land/feat', d);
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'PreToolUse');
  assert.match(ctx.additionalContext, /land preflight warning: COORDINATOR CHECK \(advisory\): coordinated on BRO-5955/);
});

test('coordinatorWarnings: seam result is used, a crashing check is silent', async () => {
  const { runHook, coordinatorWarnings } = await import('../../scripts/lib/land-preflight.mjs');
  assert.deepEqual(coordinatorWarnings({ root: '/nonexistent', src: 'HEAD', target: 'land/x' }), []);
  assert.deepEqual(coordinatorWarnings({ root: '/x', src: 'HEAD', target: 'land/x', seams: { coordinator: () => { throw new Error('boom'); } } }), []);
  const { wt } = landFixture();
  sh(wt, 'git reset -q --hard origin/main && echo z >> g.txt && git commit -qam ok');
  const v = runHook({ command: 'git push origin HEAD:refs/heads/land/feat', cwd: wt, env: ENV, seams: { coordinator: () => ['COORDINATOR CHECK: BRO-5955'] } });
  assert.notEqual(v.decision, 'block');
  assert.ok(v.warnings.includes('COORDINATOR CHECK: BRO-5955'), JSON.stringify(v.warnings));
});
