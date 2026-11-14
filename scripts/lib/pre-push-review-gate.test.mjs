// BRO-5915: sessions never open, ready or merge Broadwayscore PRs (the owner
// never reviews or merges them; work lands via land/<name>). Drives the real
// .claude/hooks/pr-write-guard.sh (Bash routes) and
// .claude/hooks/github-main-guard.sh (MCP route) (CLAUDE.md §15).
//
// The Bash routes used to live in .claude/hooks/pre-push-review-gate.sh, and
// this file pointed there — which is how BRO-5926 hid: that hook is a project
// copy of a ~/.claude/hooks master and self-skips whenever the master exists,
// the master has no PR check, and these tests ran under a HOME with no
// ~/.claude/hooks at all. So the suite was green while `gh pr create` was
// unguarded on the owner's Mac, where the master DOES exist. The guard now
// lives in its own repo-only hook with no master twin, and the Mac-shaped-HOME
// test below fails if it ever moves back behind a self-skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'pr-write-guard.sh');
const REVIEW_GATE = path.join(REPO_ROOT, '.claude', 'hooks', 'pre-push-review-gate.sh');
const GUARD = path.join(REPO_ROOT, '.claude', 'hooks', 'github-main-guard.sh');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5915-pr-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
// A cloud-shaped HOME: no ~/.claude/hooks at all. The Mac-shaped one is built
// in the self-skip test below, which is the case that BRO-5926 needed.
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome);
function repo(name, origin) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'feature', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}
const bwsRepo = repo('bws', 'https://github.com/thomaspryor/Broadwayscore.git');
const otherRepo = repo('other', 'git@github.com:thomaspryor/BroadwayScorecard-app.git');
execFileSync('git', ['-C', otherRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
const otherClone = path.join(scratch, 'tech-scorecard');
execFileSync('git', ['clone', '-q', '--no-hardlinks', otherRepo, otherClone]);
execFileSync('git', ['-C', otherClone, 'remote', 'set-url', 'origin', 'https://github.com/thomaspryor/tech-scorecard.git']);

// Real git directories and the real gate libraries. Only the command text is
// inspected: none of these probes executes a push or a generated script.
fs.symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(bwsRepo, 'scripts'), 'dir');
execFileSync('git', ['-C', bwsRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
execFileSync('git', ['-C', bwsRepo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
execFileSync('git', ['-C', bwsRepo, 'branch', 'main', 'HEAD']);
execFileSync('git', ['-C', bwsRepo, 'checkout', '-q', '-b', 'merge-candidate']);
fs.mkdirSync(path.join(bwsRepo, 'src'));
fs.writeFileSync(path.join(bwsRepo, 'src', 'probe.tsx'), Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
execFileSync('git', ['-C', bwsRepo, 'add', 'src/probe.tsx']);
execFileSync('git', ['-C', bwsRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'gated candidate']);
execFileSync('git', ['-C', bwsRepo, 'checkout', '-q', 'feature']);
const ownWorktree = path.join(scratch, 'own-worktree');
execFileSync('git', ['-C', bwsRepo, 'worktree', 'add', '-q', '-b', 'own-worktree', ownWorktree]);
const nonRepo = path.join(scratch, 'scratchpad');
fs.mkdirSync(nonRepo);
const transcript = path.join(scratch, 'transcript.jsonl');
fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Check the gate' } })}\n`);

function pushGate(command, hook = REVIEW_GATE, cwd = bwsRepo) {
  return spawnSyncStdinFile('bash', [hook], {
    cwd,
    input: JSON.stringify({ tool_input: { command }, transcript_path: transcript, session_id: 'bro-6136-test' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, REVIEW_GATE_DISABLE: '', LAND_ENFORCE_OFF: '', VISUAL_QA_DISABLE: '' },
    timeout: 20000,
  });
}

function scriptPush(target, ref = 'HEAD:main') {
  return `cd ${nonRepo}\ncat > ts-commit-push.sh <<'SH'\ncd ${target}\ngit add .; git commit -m fixture; git push origin ${ref}\nSH\nbash ts-commit-push.sh`;
}

test('BRO-6136: scratchpad then another repo in a generated push script is out of scope', () => {
  const r = pushGate(scriptPush(otherClone));
  assert.equal(r.status, 0, r.stderr);
});

test('BRO-6136: scratchpad then our own worktree still refuses a direct main push', () => {
  const r = pushGate(scriptPush(ownWorktree, 'main'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /sessions never push main directly/);
});

test('BRO-6136: successive cds already work in the PR-write parser', () => {
  assert.equal(run(`cd ${nonRepo}; cd ${otherRepo}; gh pr create --fill`).status, 0);
  assert.ok(blockedByPr(run(`cd ${nonRepo}; cd ${ownWorktree}; gh pr create --fill`)));
});

test('BRO-6136: relative cd is resolved from the actual subdirectory, not the repo root', () => {
  const subdir = path.join(bwsRepo, 'nested');
  fs.mkdirSync(subdir);
  fs.mkdirSync(path.join(bwsRepo, 'tech-scorecard'));
  const r = pushGate('cd ../tech-scorecard; git push origin main', REVIEW_GATE, subdir);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /sessions never push main directly/);
});

for (const [name, command, expected] of [
  ['plain successive cds', `cd ${nonRepo}; cd ${otherClone}; git push origin HEAD:main`, 0],
  ['relative second cd', `cd ${scratch}; cd tech-scorecard; git push origin HEAD:main`, 0],
  ['external push piped with stderr redirected', `cd ${otherClone} && git push origin main 2>&1 | tail -3`, 0],
  ['external push with a simple retry', `cd ${otherClone} && git push origin main || git push origin main`, 0],
  ['external push with a grouped rebase retry', `cd ${otherClone} && git push origin main || (git pull --rebase && git push origin main)`, 0],
  ['unrelated pipeline before an external push', `true | cat; cd ${otherClone}; git push origin main`, 0],
  ['external background push after a completed cd', `cd ${otherClone}; git push origin main &`, 0],
  ['uncertain later cd cannot redirect an external push to the session root', `cd ${otherClone}; git push origin main; true || cd ${ownWorktree}`, 0],
  ['own push piped with stderr redirected', `cd ${ownWorktree} && git push origin main 2>&1 | tail -3`, 2],
  ['own push with a retry', `cd ${ownWorktree} && git push origin main || git push origin main`, 2],
  ['conditional cd cannot hide an own push', `false && cd ${otherClone}; git push origin main`, 2],
  ['pipelined cd cannot hide an own push', `cd ${otherClone} | cat; git push origin main`, 2],
  ['cd after OR cannot hide an own push', `true || cd ${otherClone}; git push origin main`, 2],
  ['cd after push cannot change its target', `cd ${nonRepo}; cd ${ownWorktree}; git push origin main\ncd ${otherClone}`, 2],
  ['subshell cd cannot change an outer push', `cd ${nonRepo}; (cd ${otherClone} && true); git push origin main`, 2],
  ['a later quoted own worktree stays in scope', `cd ${nonRepo}; cd ${otherClone}; cd "${ownWorktree}"; git push origin main`, 2],
  ['a push inside the other repo subshell is out of scope', `cd ${nonRepo}; (cd ${otherClone} && git push origin HEAD:main)`, 0],
  ['another repo push cannot hide our later push', `cd ${otherClone}; git push origin HEAD:main; cd ${ownWorktree}; git push origin main`, 2],
]) {
  test(`BRO-6136: ${name}`, () => {
    const r = pushGate(command);
    assert.equal(r.status, expected, r.stderr);
    if (expected === 2) assert.match(r.stderr, /sessions never push main directly/);
  });
}

for (const [hook, operation, blockMessage] of [
  ['pre-merge-review-gate.sh', 'git checkout main && git merge merge-candidate', /BLOCKED/],
  ['pre-push-visual-gate.sh', 'git push origin merge-candidate', /BLOCKED/],
]) {
  test(`BRO-6136: ${hook} exempts other repos and keeps our worktree guarded`, () => {
    const hookPath = path.join(REPO_ROOT, '.claude', 'hooks', hook);
    const external = pushGate(`cd ${nonRepo}; cd ${otherClone}; ${operation}`, hookPath);
    assert.equal(external.status, 0, external.stderr);
    const own = pushGate(`cd ${nonRepo}; cd ${ownWorktree}; ${operation}`, hookPath);
    assert.equal(own.status, 2, own.stderr);
    assert.match(own.stderr, blockMessage);
  });
}

const blockedByPr = (r) => r.status === 2 && /never open, ready or merge Broadwayscore PRs \(BRO-5915/.test(r.stderr);

// No transcript_path on purpose: the PR block must not depend on the
// transcript fail-open further down the hook.
function run(command, { cwd = bwsRepo, cwdField, env = {} } = {}) {
  const payload = { tool_input: { command }, session_id: 'bro-5915-test', tool_use_id: 'tu-1' };
  if (cwdField !== undefined) payload.cwd = cwdField;
  const r = spawnSyncStdinFile('bash', [HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: cwd, LAND_ENFORCE_OFF: '', PR_GUARD_OFF: '', REVIEW_GATE_DISABLE: '', GH_REPO: '', ...env },
    timeout: 60000,
  });
  return { status: r.status, stderr: r.stderr || '' };
}

for (const cmd of [
  'gh pr create --draft --fill',
  'gh pr create --title "x" --body "y"',
  'gh pr ready 42',
  'gh pr merge 42 --squash --admin --delete-branch',
  'git push origin HEAD:refs/heads/claude/x && gh pr create --fill',
  'GH_TOKEN=abc gh pr create --fill',
  'gh pr create -R thomaspryor/Broadwayscore --fill',
  // -R BEFORE the subcommand: skipping the flag but not its value made the
  // parser read "thomaspryor/Broadwayscore" as the subcommand (ship-check).
  'gh -R thomaspryor/Broadwayscore pr create --fill',
  'gh --repo thomaspryor/Broadwayscore pr merge 42 --squash',
  // Prefixes that carry an argument of their own before the real command.
  'timeout 30 gh pr create --fill',
  'timeout -k 5 30s gh pr create --fill',
  'nice -n 5 gh pr create --fill',
  'eval "gh pr create --fill"',
  'gh pr create --repo=ThomasPryor/BroadwayScore --fill',
  'gh api -X POST repos/thomaspryor/Broadwayscore/pulls -f head=x -f base=main -f title=t',
  'gh api repos/thomaspryor/Broadwayscore/pulls -f head=x -f base=main',
  'gh api repos/{owner}/{repo}/pulls -F head=x',
  'gh api --method PUT repos/thomaspryor/Broadwayscore/pulls/42/merge',
  'curl -sS -X POST -H "Authorization: token $T" https://api.github.com/repos/thomaspryor/Broadwayscore/pulls -d @body.json',
  // Ship-check round 1: each command is judged on its own arguments.
  'gh pr list -R thomaspryor/BroadwayScorecard-app; gh pr create --fill',
  'gh run list --repo other/x && gh pr create --fill',
  'gh api -X GET user; gh api -X POST repos/thomaspryor/Broadwayscore/pulls --input body.json',
  'gh api -X GET repos/thomaspryor/Broadwayscore/pulls; gh api repos/thomaspryor/Broadwayscore/pulls -f head=x -f base=main',
  // …and wherever the command starts.
  '   gh pr create --fill',
  'bash -lc \'gh pr create --fill\'',
  'sh -c "cd /tmp && GH_REPO=thomaspryor/Broadwayscore gh pr create --fill"',
  '\\gh pr create --fill',
  '/usr/local/bin/gh pr create --fill',
  'if true; then gh pr create --fill; fi',
  '{ gh pr create --fill; }',
  'for i in 1; do\n  gh pr merge 42 --squash\ndone',
  'echo $(gh pr create --fill)',
  'env -u FOO gh pr ready 42',
  'gh pr merge https://github.com/thomaspryor/Broadwayscore/pull/42 --squash',
  'gh api graphql -f query=\'mutation { createPullRequest(input: {}) { pullRequest { url } } }\'',
  // BRO-5932: routes the first parser missed.
  'gh api --method PATCH repos/thomaspryor/Broadwayscore/pulls/4 -f draft=false',
  'gh api -X PATCH repos/thomaspryor/Broadwayscore/pulls/4 -F draft=false',
  'curl -X PATCH -H "Authorization: token $T" https://api.github.com/repos/thomaspryor/Broadwayscore/pulls/4 -d \'{"draft": false}\'',
  'curl -X POST https://api.github.com/graphql -d \'{"query":"mutation{createPullRequest(input:{}){clientMutationId}}"}\'',
  'curl -sS -H "Authorization: bearer $T" --data \'{"query":"mutation { markPullRequestReadyForReview(input:{pullRequestId:\\"x\\"}) { clientMutationId } }"}\' https://api.github.com/graphql',
  // …payload in a file that is written earlier in the same command, or exists already.
  'cat > q.json <<EOF\n{"query":"mutation { mergePullRequest(input:{pullRequestId:\\"x\\"}) { clientMutationId } }"}\nEOF\ngh api graphql --input q.json',
  'echo \'{"query":"mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }"}\' > q.json && gh api graphql --input q.json',
  'curl -X POST https://api.github.com/graphql -d @q.json; echo createPullRequest > q.json',
  'hub pull-request -m "x"',
  'hub api repos/thomaspryor/Broadwayscore/pulls -f head=x -f base=main',
  // A shell that runs the script: heredoc, here-string, pipe.
  'bash <<EOF\ngh pr create --fill\nEOF',
  'bash <<\'EOF\'\ngh pr merge 42 --squash\nEOF',
  'sudo -u bob bash -s <<EOF\ngh pr ready 42\nEOF',
  'cat <<EOF | sh\ngh pr create --fill\nEOF',
  'eval "$(cat <<\'EOF\'\ngh pr create --fill\nEOF\n)"',
  'bash <<< "gh pr create --fill"',
  // Ship-check: an unbalanced quote in the body, sudo flag values, a reader of the payload file.
  'bash <<\'EOF\'\necho it\'s fine\nEOF\ngh pr create --fill',
  'sudo -u bob gh pr create --fill',
  'echo "gh pr create --fill" | bash',
  'printf \'%s\\n\' "gh pr merge 42" | sh -s',
  'git push origin HEAD:refs/heads/land/x\nbash <<EOF\nGH_REPO=thomaspryor/Broadwayscore gh pr create --fill\nEOF',
]) {
  test(`blocks a Broadwayscore PR write: ${cmd}`, () => {
    const r = run(cmd);
    assert.ok(blockedByPr(r), `expected the PR block, got exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /refs\/heads\/land\/<name>/, 'must say how to land');
  });
}

test('a payload file that never ends cannot hang the guard (/dev/zero)', () => {
  const t0 = Date.now();
  run('gh api graphql --input /dev/zero');
  assert.ok(Date.now() - t0 < 20000);
});

test('GH_REPO pointing at Broadwayscore blocks even from another repo', () => {
  assert.ok(blockedByPr(run('gh pr create --fill', { cwd: otherRepo, env: { GH_REPO: 'thomaspryor/Broadwayscore' } })));
  assert.ok(blockedByPr(run('GH_REPO=thomaspryor/Broadwayscore gh pr create --fill', { cwd: otherRepo })));
});

for (const [cmd, opts] of [
  ['gh pr view 42 --json state', {}],
  ['gh pr list --state open', {}],
  ['gh pr checks 42', {}],
  ['gh pr close 42 --comment "landed via land.yml"', {}],
  ['gh api repos/thomaspryor/Broadwayscore/pulls/42', {}],
  ['gh api -X GET repos/thomaspryor/Broadwayscore/pulls -f state=open', {}],
  ['gh api repos/thomaspryor/Broadwayscore/actions/runs -f per_page=5', {}],
  ['grep -n "gh pr create" CLAUDE.md', {}],
  ['echo "never run gh pr merge here"', {}],
  ['gh pr create --fill', { cwd: otherRepo }],
  ['gh pr create --repo thomaspryor/BroadwayScorecard-app --fill', {}],
  ['gh api -X POST repos/thomaspryor/BroadwayScorecard-app/pulls -f head=x', {}],
  // Ship-check round 1 false positives.
  ["gh api 'repos/thomaspryor/Broadwayscore/pulls?state=open' && gh api -X POST repos/thomaspryor/Broadwayscore/issues/5/comments -f body=x", {}],
  ['gh api repos/thomaspryor/Broadwayscore/pulls/42/comments -f body=looks-good', {}],
  ['gh label create pr merge', {}],
  ['gh api graphql -f query=\'{ repository(owner:"a", name:"b") { pullRequests(first:5) { nodes { url } } } }\'', {}],
  ['git commit -q -F - <<EOF\nBRO-5915: refuse PRs\n\ngh pr merge is refused now\ngh api repos/thomaspryor/Broadwayscore/pulls -f head=x\nEOF', {}],
  ['git commit -m "gh pr create is refused; land instead"', {}],
  [`cd ${otherRepo} && gh pr create --fill`, {}],
  // BRO-5932 false-positive guards.
  ['gh api --method PATCH repos/thomaspryor/Broadwayscore/pulls/4 -f title=new', {}],
  ['gh api --method PATCH repos/thomaspryor/Broadwayscore/pulls/4 -f draft=true', {}],
  ['curl -X POST https://api.github.com/graphql -d \'{"query":"{ viewer { login } }"}\'', {}],
  ['gh api graphql --input q.json', {}],
  ['hub pr list', {}],
  ['bash <<EOF\necho gh pr create is refused\nEOF', {}],
  ['cat <<EOF\ngh pr create --fill\nEOF', {}],
  ['bash script.sh <<EOF\ngh pr create --fill\nEOF', {}],
  ['ssh host bash <<EOF\ngh pr create --fill\nEOF', {}],
  ['echo "gh pr create --fill" | cat', {}],
  ['bash <<EOF\ngh pr create --fill\nEOF', { cwd: otherRepo }],
  ['gh api --method PATCH repos/thomaspryor/Broadwayscore/pulls/4 -f title="draft: false alarm"', {}],
  ["gh api --method PATCH repos/thomaspryor/Broadwayscore/pulls/4 -f body='set draft=false later'", {}],
]) {
  test(`does not PR-block: ${cmd}${opts.cwd ? ' (other repo)' : ''}`, () => {
    const r = run(cmd, opts);
    assert.ok(!blockedByPr(r), `must not trip the PR block, got: ${r.stderr.slice(0, 200)}`);
  });
}

test('the command\'s own cd decides the repo', () => {
  assert.ok(blockedByPr(run(`cd ${bwsRepo} && gh pr create --fill`, { cwd: otherRepo })));
  assert.ok(blockedByPr(run(`(cd ${otherRepo}) && gh pr create --fill`)), 'a subshell cd does not leak out');
});

test('PR_GUARD_OFF=1 is the narrow override (prefix, env, file)', () => {
  assert.ok(!blockedByPr(run('PR_GUARD_OFF=1 gh pr create --fill')));
  assert.ok(!blockedByPr(run('gh pr create --fill', { env: { PR_GUARD_OFF: '1' } })));
  const home = path.join(scratch, 'home-prguard-off');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'PR_GUARD_OFF'), '');
  assert.ok(!blockedByPr(run('gh pr create --fill', { env: { HOME: home } })));
});

test('overrides: LAND_ENFORCE_OFF=1 (prefix, env) and the $HOME/.claude/LAND_ENFORCE_OFF file', () => {
  assert.ok(!blockedByPr(run('LAND_ENFORCE_OFF=1 gh pr create --fill')));
  assert.ok(!blockedByPr(run('gh pr create --fill', { env: { LAND_ENFORCE_OFF: '1' } })));
  const home = path.join(scratch, 'home-off');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'LAND_ENFORCE_OFF'), '');
  assert.ok(!blockedByPr(run('gh pr create --fill', { env: { HOME: home } })));
});

// ── BRO-5926: the guard must not depend on a self-skip preamble ─────────────

test('a Mac-shaped HOME (a ~/.claude/hooks master present) still blocks', () => {
  // The hole this test exists for: pre-push-review-gate.sh self-skips to the
  // user-level master whenever one exists, and that master carries no PR
  // check. Every other case here runs under a HOME with no ~/.claude/hooks, so
  // none of them can see it. Build the Mac shape explicitly: a master copy of
  // the review gate on disk, which is the condition that silenced the guard.
  const macHome = path.join(scratch, 'home-mac-shaped');
  fs.mkdirSync(path.join(macHome, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(REVIEW_GATE, path.join(macHome, '.claude', 'hooks', 'pre-push-review-gate.sh'));
  // Also plant a twin of THIS hook, so a preamble keyed on its own master
  // (rather than the review gate's) is exercised too, not just excluded by the
  // source scan in the next test.
  fs.copyFileSync(HOOK, path.join(macHome, '.claude', 'hooks', 'pr-write-guard.sh'));
  const r = run('gh pr create --fill', { env: { HOME: macHome } });
  assert.ok(
    blockedByPr(r),
    'the PR guard must fire with a ~/.claude/hooks master present — if this fails, the check has moved '
    + `back behind a self-skip preamble (BRO-5926). Got exit ${r.status}: ${r.stderr.slice(0, 200)}`,
  );
});

test('pr-write-guard.sh has no ~/.claude/hooks twin to self-skip to', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(
    src,
    /\$\{?HOME\}?"?\/\.claude\/hooks/,
    'pr-write-guard.sh must not grow a self-skip preamble: a master twin would reopen BRO-5926',
  );
});

test('the PR check is not re-added to pre-push-review-gate.sh', () => {
  // Two owners would mean one of them can rot unnoticed, and the one in the
  // review gate is the one that cannot fire on the Mac.
  const src = fs.readFileSync(REVIEW_GATE, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.doesNotMatch(
    src,
    /pr-command\.mjs/,
    'the PR-write check belongs in .claude/hooks/pr-write-guard.sh only — pre-push-review-gate.sh self-skips '
    + 'to a master that has no such check, so a copy here is dead on the Mac (BRO-5926)',
  );
});

// The hook runs as its own process, whose cwd is NOT the session's working
// directory — only the payload's `cwd` field says where the Bash call will run.
// Both directions are pinned, because a regression to process.cwd() breaks one
// way (missed refusal) and over-blocks the other.
test('the payload cwd decides the repo, not the hook process cwd — a Broadwayscore session blocks', () => {
  const r = run('gh pr create --fill', { cwd: otherRepo, cwdField: bwsRepo });
  assert.ok(blockedByPr(r), `payload cwd must win; got exit ${r.status}: ${r.stderr.slice(0, 200)}`);
});

test('the payload cwd decides the repo — a non-Broadwayscore session does not block', () => {
  const r = run('gh pr create --fill', { cwd: bwsRepo, cwdField: otherRepo });
  assert.ok(!blockedByPr(r), `payload cwd must win; got exit ${r.status}: ${r.stderr.slice(0, 200)}`);
});

test('a missing or non-string payload cwd falls back to the process cwd, never to "allow"', () => {
  assert.ok(blockedByPr(run('gh pr create --fill', { cwd: bwsRepo })), 'absent cwd field');
  assert.ok(blockedByPr(run('gh pr create --fill', { cwd: bwsRepo, cwdField: 42 })), 'non-string cwd field');
  assert.ok(blockedByPr(run('gh pr create --fill', { cwd: bwsRepo, cwdField: '' })), 'empty cwd field');
});

test('settings.json registers pr-write-guard.sh on Bash', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks.PreToolUse.find((h) => (h.hooks || []).some((x) => /pr-write-guard\.sh/.test(x.command)));
  assert.ok(entry, 'pr-write-guard.sh must be registered as a PreToolUse hook, or it never runs');
  assert.ok(new RegExp(`^(?:${entry.matcher})$`).test('Bash'), `matcher ${entry.matcher} must cover Bash`);
});

// ── MCP route: github-main-guard.sh ─────────────────────────────────────────
function guard(tool, input, env = {}) {
  const r = spawnSyncStdinFile('bash', [GUARD], {
    cwd: REPO_ROOT,
    input: JSON.stringify({ tool_name: `mcp__github__${tool}`, tool_input: input, session_id: 'bro-5915-test' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, LAND_ENFORCE_OFF: '', PR_GUARD_OFF: '', ...env },
    timeout: 60000,
  });
  return { status: r.status, stderr: r.stderr || '' };
}
const PR = { title: 't', head: 'claude/x', base: 'main', draft: true };

test('MCP create_pull_request on Broadwayscore is refused (any case / .git)', () => {
  for (const repoName of ['Broadwayscore', 'broadwayscore.git']) {
    const r = guard('create_pull_request', { owner: 'ThomasPryor', repo: repoName, ...PR });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /never open Broadwayscore PRs \(BRO-5915\)/);
    assert.match(r.stderr, /refs\/heads\/land\/<name>/);
  }
});

test('MCP create_pull_request on another repo, or with the override file, passes', () => {
  assert.equal(guard('create_pull_request', { owner: 'thomaspryor', repo: 'BroadwayScorecard-app', ...PR }).status, 0);
  const home = path.join(scratch, 'home-off-mcp');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'LAND_ENFORCE_OFF'), '');
  assert.equal(guard('create_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', ...PR }, { HOME: home }).status, 0);
});

test('MCP: PR_GUARD_OFF file lifts only the PR check; main writes stay refused', () => {
  const home = path.join(scratch, 'home-prguard-mcp');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'PR_GUARD_OFF'), '');
  assert.equal(guard('create_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', ...PR }, { HOME: home }).status, 0);
  assert.equal(guard('merge_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', pullNumber: 42 }, { HOME: home }).status, 2);
  assert.equal(guard('push_files', { owner: 'thomaspryor', repo: 'Broadwayscore', branch: 'main', files: [] }, { HOME: home }).status, 2);
});

test('closing an old PR via update_pull_request still works (CLOUD.md § Landing step 3)', () => {
  assert.equal(guard('update_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', pullNumber: 42, state: 'closed' }).status, 0);
});

test('settings.json registers github-main-guard.sh on create_pull_request', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks.PreToolUse.find((h) => (h.hooks || []).some((x) => /github-main-guard\.sh/.test(x.command)));
  const re = new RegExp(`^(?:${entry.matcher})$`);
  assert.ok(re.test('mcp__github__create_pull_request'));
  assert.ok(!re.test('mcp__github__update_pull_request'), 'closing PRs must stay unguarded');
});

// BRO-5931: the task #584 CI-red claim check sat below this hook's self-skip
// preamble (dead on the Mac) with a Mac-local ledger (dead in cloud), and never
// ran. The whole mechanism was removed; this keeps a guard that must hold
// everywhere from being re-added behind the preamble under the same names.
test('pre-push-review-gate.sh carries no CI-red claim check behind the self-skip preamble', () => {
  const src = fs.readFileSync(REVIEW_GATE, 'utf8');
  assert.doesNotMatch(src, /claim-ci-red|ci-red-claim|CI_RED_CLAIM|CI-RED-TASK/);
  for (const dead of ['scripts/claim-ci-red.js', 'scripts/lib/ci-red-claims.js']) {
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, dead)), `${dead} should stay deleted (BRO-5931)`);
  }
});
