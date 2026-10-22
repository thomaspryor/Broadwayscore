// BRO-5915: sessions never open, ready or merge Broadwayscore PRs (the owner
// never reviews or merges them; work lands via land/<name>). Drives the real
// .claude/hooks/pre-push-review-gate.sh (Bash routes) and
// .claude/hooks/github-main-guard.sh (MCP route) (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'pre-push-review-gate.sh');
const GUARD = path.join(REPO_ROOT, '.claude', 'hooks', 'github-main-guard.sh');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5915-pr-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
// A HOME without ~/.claude/hooks so the repo copy never self-skips (a Mac HOME would).
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

const blockedByPr = (r) => r.status === 2 && /never open, ready or merge Broadwayscore PRs \(BRO-5915/.test(r.stderr);

// No transcript_path on purpose: the PR block must not depend on the
// transcript fail-open further down the hook.
function run(command, { cwd = bwsRepo, env = {} } = {}) {
  const r = spawnSyncStdinFile('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ tool_input: { command }, session_id: 'bro-5915-test', tool_use_id: 'tu-1' }),
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
]) {
  test(`blocks a Broadwayscore PR write: ${cmd}`, () => {
    const r = run(cmd);
    assert.ok(blockedByPr(r), `expected the PR block, got exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /refs\/heads\/land\/<name>/, 'must say how to land');
  });
}

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
