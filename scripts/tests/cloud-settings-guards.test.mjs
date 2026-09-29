// BRO-4238: settings-file fixes approved by the owner (2026-09-28):
//  - github-main-guard.sh: GitHub MCP writes/merges never change Broadwayscore main
//  - block-resend-broadcasts.sh: CLAUDE.md §17 email guard now also fires in cloud
//  - notion-create-block.sh: unregistered, but its script must stay (old snapshots call it)
// Drives the real hook scripts (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4238-settings-'));
const fakeHome = path.join(scratch, 'home');   // no ~/.claude/hooks, so repo copies never self-skip
fs.mkdirSync(fakeHome);
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function runHook(name, payload, { home = fakeHome, env = {} } = {}) {
  const r = spawnSync('bash', [path.join(HOOKS, name)], {
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
  const r = spawnSync('bash', [path.join(HOOKS, 'github-main-guard.sh')], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: fakeHome } });
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

test('settings.json: new guards registered; notion-create-block unregistered but its script kept (never delete: old snapshots still call it)', () => {
  const s = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8');
  assert.match(s, /github-main-guard\.sh/);
  assert.match(s, /block-resend-broadcasts\.sh/);
  assert.doesNotMatch(s, /notion-create-block\.sh/);
  assert.ok(fs.existsSync(path.join(HOOKS, 'notion-create-block.sh')));
  const d = JSON.parse(s);
  const mcpGroup = d.hooks.PreToolUse.find((g) => /mcp__github__/.test(g.matcher || ''));
  assert.ok(mcpGroup, 'MCP matcher group missing');
  for (const t of ['create_or_update_file', 'push_files', 'delete_file', 'merge_pull_request', 'enable_pr_auto_merge']) {
    assert.ok(new RegExp(`^(?:${mcpGroup.matcher})$`).test(`mcp__github__${t}`), `matcher must cover ${t}`);
  }
  assert.ok(!new RegExp(`^(?:${mcpGroup.matcher})$`).test('mcp__github__create_branch'), 'land branches are created with create_branch; must not be gated');
});
