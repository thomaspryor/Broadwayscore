// BRO-2394: GitHub MCP file writes skipped the Bash-only visual-QA push gate.
// Drives the real scripts/lib/mcp-push-visual-gate.sh (called by
// .claude/hooks/github-main-guard.sh), with a stub gate for
// the adapter's own logic and the real pre-push-visual-gate.sh end to end
// (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');
const ADAPTER = path.join(REPO_ROOT, 'scripts', 'lib', 'mcp-push-visual-gate.sh');
const GUARD = path.join(HOOKS, 'github-main-guard.sh');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2394-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
const transcript = path.join(scratch, 'transcript.jsonl');
fs.writeFileSync(transcript, '');
let homeN = 0;
const freshHome = () => { const h = path.join(scratch, `home-${homeN++}`); fs.mkdirSync(h); return h; };

// Stub gate: records the input it was given, exits with $STUB_RC.
const stub = path.join(scratch, 'stub-gate.sh');
const stubSeen = path.join(scratch, 'stub-seen.json');
fs.writeFileSync(stub, `#!/usr/bin/env bash\ncat > "${stubSeen}"\necho "stub gate says no" >&2\nexit "\${STUB_RC:-2}"\n`);

const BWS = { owner: 'thomaspryor', repo: 'Broadwayscore' };
const payload = (tool, input) => ({
  tool_name: `mcp__github__${tool}`, tool_input: input,
  session_id: 'bro-2394-test', transcript_path: transcript, tool_use_id: 'tu-1',
});
const ui = (extra = {}) => payload('push_files', {
  ...BWS, branch: 'land/bro-1-x', message: 'm', files: [{ path: 'src/app/page.tsx', content: 'x' }], ...extra,
});

function run(input, { env = {}, home = freshHome(), cwd = REPO_ROOT, script = ADAPTER } = {}) {
  fs.rmSync(stubSeen, { force: true });
  // Stdin from a file (BRO-5248): the adapter exits before reading on most paths.
  const r = spawnSyncStdinFile('bash', [script], {
    cwd, input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, BSC_HOOK_TEST: '1', MCP_PUSH_VISUAL_GATE: stub, MCP_PUSH_GATES_ENFORCE: '', LAND_ENFORCE_OFF: '', ...env },
  });
  const seen = fs.existsSync(stubSeen) ? JSON.parse(fs.readFileSync(stubSeen, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', seen, home };
}

// Scratch repo: origin/main plus a 'work' branch committing src/app/page.tsx,
// with the gate's libs copied in. Built once; tests leave it on 'work'.
let repoMemo = null;
function scratchRepo() {
  if (repoMemo) return repoMemo;
  const origin = path.join(scratch, 'origin.git');
  const repo = path.join(scratch, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(repo, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'work');
  fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app', 'page.tsx'), 'export default 1');
  git('add', '-A'); git('commit', '-q', '-m', 'ui');
  repoMemo = { repo, git };
  return repoMemo;
}

test('UI files in a Broadwayscore MCP push run the gate with a git-push-shaped input', () => {
  const r = run(ui());
  assert.equal(r.status, 0, 'advisory: never blocks');
  assert.ok(r.seen, 'gate was invoked');
  assert.equal(r.seen.tool_input.command, 'git push origin HEAD');
  assert.equal(r.seen.transcript_path, transcript);
  assert.equal(r.seen.session_id, 'bro-2394-test');
});

test('advisory: a would-block becomes model-visible additionalContext plus a log line', () => {
  const r = run(ui());
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /ADVISORY \(BRO-2394.*src\/app\/page\.tsx.*stub gate says no/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'must never auto-allow past permission prompts');
  const log = fs.readFileSync(path.join(r.home, '.claude', 'logs', 'mcp-push-visual-gate.log'), 'utf8');
  assert.match(log, /mcp__github__push_files\tland\/bro-1-x\tsrc\/app\/page\.tsx/);
});

test('enforce mode (env or HOME file) passes the gate block through as exit 2', () => {
  const r = run(ui(), { env: { MCP_PUSH_GATES_ENFORCE: '1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /stub gate says no/);
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'MCP_PUSH_GATES_ENFORCE'), '');
  assert.equal(run(ui(), { home }).status, 2);
});

test('gate passing means silence, in either mode, when the UI files are in this checkout\'s commits', () => {
  const { repo } = scratchRepo();
  for (const env of [{ STUB_RC: '0' }, { STUB_RC: '0', MCP_PUSH_GATES_ENFORCE: '1' }]) {
    const r = run(ui(), { env, cwd: repo });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('gate passes but the payload carries UI files this checkout never committed: reported (ship-check finding)', () => {
  const { repo } = scratchRepo();
  const unseen = ui({ files: [{ path: 'src/app/page.tsx' }, { path: 'src/components/New.tsx' }] });
  const adv = run(unseen, { env: { STUB_RC: '0' }, cwd: repo });
  assert.equal(adv.status, 0);
  assert.match(JSON.parse(adv.stdout).hookSpecificOutput.additionalContext, /not in this checkout's commits.*src\/components\/New\.tsx/);
  const enf = run(unseen, { env: { STUB_RC: '0', MCP_PUSH_GATES_ENFORCE: '1' }, cwd: repo });
  assert.equal(enf.status, 2);
  assert.match(enf.stderr, /src\/components\/New\.tsx/);
  const bypass = run({ ...unseen, tool_input: { ...unseen.tool_input, message: 'NO-VERIFY: copy-only change, no layout touched' } },
    { env: { STUB_RC: '0', MCP_PUSH_GATES_ENFORCE: '1' }, cwd: repo });
  assert.equal(bypass.status, 0);
});

test('the advisory names at most 5 UI files and counts the rest', () => {
  const many = ui({ files: Array.from({ length: 7 }, (_, i) => ({ path: `src/app/p${i}.tsx` })) });
  const out = JSON.parse(run(many).stdout).hookSpecificOutput.additionalContext;
  assert.match(out, /\(\+2 more\)/);
});

test('no UI files, another repo, or a non-write tool: the gate is never invoked', () => {
  const cases = [
    payload('push_files', { ...BWS, branch: 'land/x', message: 'm', files: [{ path: 'scripts/x.js', content: '' }] }),
    payload('push_files', { owner: 'thomaspryor', repo: 'broadway-review-texts', branch: 'main', message: 'm', files: [{ path: 'src/app/page.tsx' }] }),
    payload('create_branch', { ...BWS, branch: 'land/x' }),
  ];
  for (const c of cases) {
    const r = run(c, { env: { MCP_PUSH_GATES_ENFORCE: '1' } });
    assert.equal(r.status, 0);
    assert.equal(r.seen, null, `gate ran for ${JSON.stringify(c.tool_input).slice(0, 80)}`);
  }
});

test('create_or_update_file and delete_file are covered; owner/repo spellings normalise', () => {
  for (const [tool, input] of [
    ['create_or_update_file', { ...BWS, branch: 'land/x', path: 'src/components/A.tsx', message: 'm', content: 'x' }],
    ['delete_file', { ...BWS, branch: 'land/x', path: 'tailwind.config.js', message: 'm' }],
    ['push_files', { owner: ' ThomasPryor ', repo: 'Broadwayscore.git', branch: 'refs/heads/land/x', message: 'm', files: [{ path: '/src/app/x.css' }] }],
  ]) {
    assert.ok(run(payload(tool, input)).seen, `${tool} did not reach the gate`);
  }
});

test('NO-VERIFY in the commit message becomes the gate\'s in-command bypass comment', () => {
  const r = run(ui({ message: 'fix header NO-VERIFY: copy-only change, no layout touched' }));
  assert.equal(r.seen.tool_input.command, 'git push origin HEAD # NO-VERIFY: copy-only change, no layout touched');
  assert.equal(run(ui({ message: 'NO-VERIFY: short' })).seen.tool_input.command, 'git push origin HEAD', 'under 15 chars is ignored');
});

test('the stub seam is ignored unless BSC_HOOK_TEST=1', () => {
  const r = run(ui(), { env: { BSC_HOOK_TEST: '', MCP_PUSH_GATES_ENFORCE: '1' } });
  assert.equal(r.seen, null);
});

test('BRO-6244: writes to visual-hold/* and visual-evidence/* skip the gate; the regex matches the Bash hook\'s _HOLD_RE branch part', () => {
  for (const branch of ['visual-hold/bro-7', 'visual-evidence/bro-7']) {
    const r = run(ui({ branch }), { env: { STUB_RC: '2' } });
    assert.equal(r.status, 0, branch);
    assert.equal(r.seen, null, `${branch}: the gate must not even run`);
  }
  for (const branch of ['heads/visual-hold/bro-7', 'refs/tags/visual-hold/bro-7']) {
    assert.notEqual(run(ui({ branch }), { env: { STUB_RC: '2' } }).seen, null, `${branch}: only refs/heads/ is stripped`);
  }
  assert.equal(run(ui({ branch: 'refs/heads/visual-hold/bro-7' }), { env: { STUB_RC: '2' } }).seen, null, 'full ref of a hold branch skips');
  const lookalike = run(ui({ branch: 'visual-holdx/bro-7' }), { env: { STUB_RC: '2' } });
  assert.notEqual(lookalike.seen, null, 'a lookalike branch still reaches the gate');
  const re = (f) => /visual-\(hold\|evidence\)\/\[A-Za-z0-9\._-\]\+/.exec(fs.readFileSync(f, 'utf8'));
  assert.ok(re(ADAPTER) && re(path.join(HOOKS, 'pre-push-visual-gate.sh')));
});

test('UI_PATTERN is identical to pre-push-visual-gate.sh\'s (drift guard)', () => {
  const pat = (f) => fs.readFileSync(f, 'utf8').match(/^UI_PATTERN='([^']+)'/m)?.[1];
  assert.ok(pat(path.join(HOOKS, 'pre-push-visual-gate.sh')));
  assert.equal(pat(ADAPTER), pat(path.join(HOOKS, 'pre-push-visual-gate.sh')));
});

test('github-main-guard.sh (registered on all three MCP write tools) calls the adapter after its main check', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks.PreToolUse.find((h) => (h.hooks || []).some((x) => /github-main-guard\.sh/.test(x.command)));
  const re = new RegExp(`^(?:${entry.matcher})$`);
  for (const t of ['push_files', 'create_or_update_file', 'delete_file']) assert.ok(re.test(`mcp__github__${t}`), t);
  // land/* write with UI files: the guard passes it on to the adapter (stub sees it).
  const viaGuard = run(ui(), { script: GUARD });
  assert.equal(viaGuard.status, 0);
  assert.ok(viaGuard.seen, 'guard did not call the adapter');
  assert.match(viaGuard.stdout, /ADVISORY \(BRO-2394/);
  // main write: refused by the guard itself, the adapter never runs.
  const toMain = run(ui({ branch: 'main' }), { script: GUARD });
  assert.equal(toMain.status, 2);
  assert.equal(toMain.seen, null);
});

test('end to end with the REAL visual gate: an unverified UI commit is reported, and so is one never committed here', () => {
  const { repo, git } = scratchRepo();

  const env = { BSC_HOOK_TEST: '', MCP_PUSH_VISUAL_GATE: '' };
  const blocked = run(ui(), { cwd: repo, env });
  assert.equal(blocked.status, 0);
  assert.match(blocked.stdout, /ADVISORY \(BRO-2394/, `real gate did not report: ${blocked.stdout}${blocked.stderr}`);
  const enforced = run(ui(), { cwd: repo, env: { ...env, MCP_PUSH_GATES_ENFORCE: '1' } });
  assert.equal(enforced.status, 2);
  assert.match(enforced.stderr, /BLOCKED: push of UI changes without a visual-qa verdict/);

  // On main the local diff has no UI files: the gate itself passes, but the
  // payload's page.tsx was never committed here, so it is still reported.
  git('checkout', '-q', 'main');
  const unseen = run(ui(), { cwd: repo, env: { ...env, MCP_PUSH_GATES_ENFORCE: '1' } });
  git('checkout', '-q', 'work');
  assert.equal(unseen.status, 2);
  assert.match(unseen.stderr, /not in this checkout's commits/);
  // A backend-only write stays silent.
  const backend = payload('push_files', { ...BWS, branch: 'land/x', message: 'm', files: [{ path: 'scripts/x.js' }] });
  assert.equal(run(backend, { cwd: repo, env: { ...env, MCP_PUSH_GATES_ENFORCE: '1' } }).status, 0);
});
