// BRO-4238: settings-file fixes approved by the owner (2026-09-28):
//  - github-main-guard.sh: GitHub MCP writes/merges never change Broadwayscore main
//  - block-resend-broadcasts.sh: CLAUDE.md §17 email guard now also fires in cloud
//  - notion-create-block.sh: unregistered, and since BRO-7315 deleted (six weeks on, no snapshot still calls it)
// Drives the real hook scripts (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4238-settings-'));
const fakeHome = path.join(scratch, 'home');   // no ~/.claude/hooks, so repo copies never self-skip
fs.mkdirSync(fakeHome);
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function runHook(name, payload, { home = fakeHome, env = {} } = {}) {
  const r = spawnSyncStdinFile('bash', [path.join(HOOKS, name)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: home, LAND_ENFORCE_OFF: '', ...env },
  });
  return { status: r.status, stderr: r.stderr || '' };
}
const mcp = (tool, input) => ({ tool_name: `mcp__github__${tool}`, tool_input: input });
const BWS = { owner: 'thomaspryor', repo: 'Broadwayscore' };

// ── github-main-guard.sh ───────────────────────────────────────────────────

for (const tool of ['create_or_update_file', 'push_files', 'delete_file']) {
  test(`github-main-guard: ${tool} to Broadwayscore main is refused, with the land route`, () => {
    for (const branch of ['main', 'refs/heads/main', 'heads/main', ' main ']) {
      const r = runHook('github-main-guard.sh', mcp(tool, { ...BWS, branch, path: 'x', message: 'm' }));
      assert.equal(r.status, 2, `${tool} ${branch}: ${r.stderr}`);
      assert.match(r.stderr, /land\/<name>/);
    }
  });
}

test('github-main-guard: owner/repo spelled another way still resolve to Broadwayscore', () => {
  for (const [owner, repo] of [['ThomasPryor', 'BroadwayScore'], [' thomaspryor', 'Broadwayscore.git'], ['THOMASPRYOR', 'broadwayscore ']]) {
    const r = runHook('github-main-guard.sh', mcp('push_files', { owner, repo, branch: 'main', files: [], message: 'm' }));
    assert.equal(r.status, 2, `${owner}/${repo}: ${r.stderr}`);
  }
  // A branch that merely contains "main" is not main.
  assert.equal(runHook('github-main-guard.sh', mcp('push_files', { ...BWS, branch: 'land/main-fix', files: [], message: 'm' })).status, 0);
  assert.equal(runHook('github-main-guard.sh', mcp('push_files', { ...BWS, branch: 'mainline', files: [], message: 'm' })).status, 0);
});

test('github-main-guard: merging or auto-merging a Broadwayscore PR is refused', () => {
  for (const tool of ['merge_pull_request', 'enable_pr_auto_merge']) {
    const r = runHook('github-main-guard.sh', mcp(tool, { ...BWS, pullNumber: 1 }));
    assert.equal(r.status, 2, tool);
    assert.match(r.stderr, /never merged directly/);
  }
});

test('github-main-guard: land branches, other branches, other repos and other tools pass', () => {
  assert.equal(runHook('github-main-guard.sh', mcp('create_or_update_file', { ...BWS, branch: 'land/fix-x' })).status, 0);
  assert.equal(runHook('github-main-guard.sh', mcp('push_files', { ...BWS, branch: 'claude/some-work' })).status, 0);
  assert.equal(runHook('github-main-guard.sh', mcp('push_files', { owner: 'thomaspryor', repo: 'brownstone-model', branch: 'main' })).status, 0);
  assert.equal(runHook('github-main-guard.sh', mcp('merge_pull_request', { owner: 'thomaspryor', repo: 'BroadwayScorecard-app', pullNumber: 3 })).status, 0);
  assert.equal(runHook('github-main-guard.sh', mcp('create_branch', { ...BWS, branch: 'land/x', from_branch: 'main' })).status, 0);
  assert.equal(runHook('github-main-guard.sh', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
});

test('github-main-guard: emergency override (env or ~/.claude/LAND_ENFORCE_OFF file) and garbage input fail open', () => {
  const blocked = mcp('create_or_update_file', { ...BWS, branch: 'main' });
  assert.equal(runHook('github-main-guard.sh', blocked, { env: { LAND_ENFORCE_OFF: '1' } }).status, 0);
  const home = path.join(scratch, 'home-off');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'LAND_ENFORCE_OFF'), '');
  assert.equal(runHook('github-main-guard.sh', blocked, { home }).status, 0);
  const r = spawnSyncStdinFile('bash', [path.join(HOOKS, 'github-main-guard.sh')], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: fakeHome } });
  assert.equal(r.status, 0);
});

// ── block-resend-broadcasts.sh (repo copy of the Mac master) ───────────────

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('resend guard: a direct broadcasts API call is refused in cloud', () => {
  const r = runHook('block-resend-broadcasts.sh', bash('curl -X POST https://api.resend.com/broadcasts/abc/send -H "Authorization: Bearer x"'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /RESEND BROADCAST GUARD/);
});

test('resend guard: the sanctioned send script and unrelated commands pass', () => {
  assert.equal(runHook('block-resend-broadcasts.sh', bash('node scripts/send-opening-night-broadcast.js --send-to=me@example.com')).status, 0);
  assert.equal(runHook('block-resend-broadcasts.sh', bash('ls -la')).status, 0);
});

test('resend guard: the repo copy finds its strip lib, so a commit message may mention the URL but a chained curl is still caught (BRO-2645)', () => {
  assert.ok(fs.existsSync(path.join(HOOKS, 'lib', 'strip-git-commit-noise.js')), 'lib must ship next to the hook');
  assert.equal(runHook('block-resend-broadcasts.sh', bash('git commit -m "docs: never call resend.com/broadcasts directly"')).status, 0);
  assert.equal(runHook('block-resend-broadcasts.sh', bash('git commit -m "x"; curl -X POST https://api.resend.com/broadcasts/1/send')).status, 2);
});

// ── settings.json wiring ───────────────────────────────────────────────────

test('settings.json: new guards registered; notion-create-block unregistered and its script gone (BRO-7315)', () => {
  const s = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8');
  assert.match(s, /github-main-guard\.sh/);
  assert.match(s, /block-resend-broadcasts\.sh/);
  assert.doesNotMatch(s, /notion-create-block\.sh/);
  assert.ok(!fs.existsSync(path.join(HOOKS, 'notion-create-block.sh')), 'retired with Notion; do not merge it back from ~/.claude/hooks');
  const d = JSON.parse(s);
  const mcpGroup = d.hooks.PreToolUse.find((g) => /mcp__github__/.test(g.matcher || ''));
  assert.ok(mcpGroup, 'MCP matcher group missing');
  for (const t of ['create_or_update_file', 'push_files', 'delete_file', 'merge_pull_request', 'enable_pr_auto_merge']) {
    assert.ok(new RegExp(`^(?:${mcpGroup.matcher})$`).test(`mcp__github__${t}`), `matcher must cover ${t}`);
  }
  assert.ok(!new RegExp(`^(?:${mcpGroup.matcher})$`).test('mcp__github__create_branch'), 'land branches are created with create_branch; must not be gated');
});

// ── enterworktree-guard.sh (BRO-7315 proof tests) ──────────────────────────
// Real hook + real scripts/check-worktree-collision.js against a throwaway git repo that holds a
// real linked worktree. BROADWAYSCORE_REPO points the hook at that repo.
import { spawnSync } from 'node:child_process';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function worktreeRepo(label, { dirty }) {
  const repo = fs.mkdtempSync(path.join(scratch, `ewg-${label}-`));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  // The hook runs $BROADWAYSCORE_REPO/scripts/check-worktree-collision.js, so the repo carries the real script + its libs.
  for (const rel of ['scripts/check-worktree-collision.js', 'scripts/lib/duplicate-dispatch-guard.js', 'scripts/lib/cli-help.js', 'scripts/lib/worktree-lock-parse.js']) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(repo, rel));
  }
  const wt = path.join(repo, '.claude', 'worktrees', 'proof-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'proof-wt', wt);
  if (dirty) fs.writeFileSync(path.join(wt, 'wip.txt'), 'another session is mid-edit\n');
  return repo;
}
const enterWorktree = (name) => ({ tool_name: 'EnterWorktree', tool_input: { name } });

test('enterworktree-guard: resuming a same-name worktree with uncommitted work is refused; the clean twin passes', () => {
  const dirtyRepo = worktreeRepo('dirty', { dirty: true });
  const refused = runHook('enterworktree-guard.sh', enterWorktree('proof-wt'), { env: { BROADWAYSCORE_REPO: dirtyRepo } });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /BLOCKED: EnterWorktree\("proof-wt"\)/);
  assert.match(refused.stderr, /uncommitted changes/);
  const cleanRepo = worktreeRepo('clean', { dirty: false });
  const ok = runHook('enterworktree-guard.sh', enterWorktree('proof-wt'), { env: { BROADWAYSCORE_REPO: cleanRepo } });
  assert.equal(ok.status, 0, ok.stderr);
});

test('enterworktree-guard: pass cases (no name, a fresh name, the kill switch) never block', () => {
  const dirtyRepo = worktreeRepo('dirty2', { dirty: true });
  const env = { BROADWAYSCORE_REPO: dirtyRepo };
  assert.equal(runHook('enterworktree-guard.sh', { tool_name: 'EnterWorktree', tool_input: { path: '/x' } }, { env }).status, 0, 'path entry has no name to collide on');
  assert.equal(runHook('enterworktree-guard.sh', enterWorktree('brand-new-name'), { env }).status, 0, 'a name with no existing worktree');
  assert.equal(runHook('enterworktree-guard.sh', enterWorktree('proof-wt'), { env: { ...env, ENTERWORKTREE_GUARD_DISABLE: '1' } }).status, 0, 'kill switch');
});

// ── check-skill-redaction.sh (BRO-7315 proof tests) ────────────────────────
// Real hook against a throwaway git repo. HOME is an empty dir: the hook self-skips when
// $HOME/.claude/hooks/check-skill-redaction.sh exists. Fixture strings are made up.
const REDACT_HOOK = path.join(HOOKS, 'check-skill-redaction.sh');
function skillRepo(label, { skillText, denylist }) {
  const repo = fs.mkdtempSync(path.join(scratch, `redact-${label}-`));
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'x', 'SKILL.md'), skillText);
  if (denylist !== undefined) fs.writeFileSync(path.join(repo, '.claude', 'skills', '.redaction-denylist.txt'), denylist);
  git(repo, 'add', '.claude/skills/x/SKILL.md');   // tracked; the denylist stays untracked, as in the real repo
  git(repo, 'commit', '-q', '-m', 'skill');
  return repo;
}
function runRedaction(repo, command = 'git push origin HEAD') {
  const home = fs.mkdtempSync(path.join(scratch, 'redact-home-'));
  const r = spawnSyncStdinFile('bash', [REDACT_HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', cwd: repo, timeout: 30000,
    env: { ...process.env, HOME: home, SKILL_REDACTION_DISABLE: '' },
  });
  return { status: r.status, stderr: r.stderr || '' };
}
const SECRET = 'zz-fake-cookie-value-48151623';

test('check-skill-redaction: a denylisted string in a tracked skill blocks a git push', () => {
  const r = runRedaction(skillRepo('hit', { skillText: `Use cookie ${SECRET} to log in\n`, denylist: `# made-up\n${SECRET}\n` }));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /PUSH BLOCKED/);
  assert.ok(r.stderr.includes('SKILL.md'), 'names the file');
});

test('check-skill-redaction: the same repo without the denylisted string passes; a non-push command passes', () => {
  const clean = skillRepo('clean', { skillText: 'Mechanism only, no identifiers\n', denylist: `${SECRET}\n` });
  assert.equal(runRedaction(clean).status, 0);
  const dirty = skillRepo('nonpush', { skillText: `Use cookie ${SECRET}\n`, denylist: `${SECRET}\n` });
  assert.equal(runRedaction(dirty, 'ls -la').status, 0, 'only push-ingress commands are checked');
});

test('check-skill-redaction: with NO denylist file the check is off (documents that it only guards machines that have the file)', () => {
  const r = runRedaction(skillRepo('nolist', { skillText: `Use cookie ${SECRET}\n` }));
  assert.equal(r.status, 0, r.stderr);
});
