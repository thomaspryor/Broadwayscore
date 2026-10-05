// BRO-2470: stale-enforcement trap audit for the Notion-aware hooks.
// Class: a policy change (Notion retired -> Linear) meeting enforcement that
// predates it. Asserts (1) a Linear-only session passes every enforcing board
// hook, (2) no hook writes state that only a SUCCESSFUL Notion create can clear.
// Hooks live in ~/.claude/hooks (claude-config repo); skipped where absent (CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const HOOKS = path.join(homedir(), '.claude/hooks');
const have = existsSync(path.join(HOOKS, 'notion-create-block.sh'));
const opts = { skip: have ? false : 'hooks not installed on this machine' };

// Fake HOME (the real one carries BOARD_GATE_DISABLED, which would make every
// hook exit 0 at the hatch and every assertion vacuous) + fake repo whose
// notion-brain.js always fails like a retired Notion: exit 6, READ-ONLY.
function world() {
  const w = mkdtempSync(path.join(tmpdir(), 'nzt-'));
  mkdirSync(path.join(w, '.claude/logs'), { recursive: true });
  mkdirSync(path.join(w, 'repo/scripts'), { recursive: true });
  writeFileSync(path.join(w, 'repo/scripts/notion-brain.js'),
    'console.error("Notion is READ-ONLY");process.exit(6);\n');
  return w;
}
const sid = () => `nzt-${process.pid}-${Math.random().toString(36).slice(2)}`;
function run(w, hook, payload) {
  const r = spawnSync('bash', [path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: w, BROADWAYSCORE_REPO: path.join(w, 'repo') },
    encoding: 'utf8', timeout: 30000,
  });
  return { rc: r.status, err: r.stderr };
}
const bash = (s, command) => ({ session_id: s, tool_input: { command } });
const cleanup = (s) => {
  for (const f of readdirSync('/tmp').filter((n) => n.includes(s))) rmSync(path.join('/tmp', f), { force: true });
};

test('Linear-only session (claim sentinel) passes commit + stop gates', opts, () => {
  const w = world(), s = sid();
  try {
    writeFileSync(`/tmp/linear-issue-claimed-${s}`, 'BRO-2470\n');
    assert.equal(run(w, 'notion-card-required-commit.sh', bash(s, 'git commit -m x')).rc, 0);
    const stop = run(w, 'notion-card-required-stop.sh', { session_id: s, transcript_path: '' });
    assert.equal(stop.rc, 0, stop.err);
    assert.equal(run(w, 'notion-create-block.sh', bash(s, 'ls')).rc, 0);
  } finally { cleanup(s); rmSync(w, { recursive: true, force: true }); }
});

test('short BRO-N sentinel id never reaches the Notion UUID probe', opts, () => {
  const w = world(), s = sid();
  try {
    writeFileSync(`/tmp/notion-card-${s}`, 'BRO-2470\n');
    const stop = run(w, 'notion-card-required-stop.sh', { session_id: s, transcript_path: '' });
    assert.equal(stop.rc, 0, stop.err);
  } finally { cleanup(s); rmSync(w, { recursive: true, force: true }); }
});

test('Notion READ-ONLY refusal clears the failure breadcrumb (no success-only state)', opts, () => {
  const w = world(), s = sid();
  try {
    writeFileSync(`/tmp/notion-create-failed-${s}`, 'FAILED\n');
    const cmd = 'node scripts/notion-brain.js create "x"';
    run(w, 'notion-create-verify.sh', { session_id: s, tool_input: { command: cmd },
      tool_response: { stdout: '', stderr: 'Notion is READ-ONLY', interrupted: false } });
    assert.equal(existsSync(`/tmp/notion-create-failed-${s}`), false);
    assert.equal(run(w, 'notion-create-block.sh', bash(s, 'ls')).rc, 0);
  } finally { cleanup(s); rmSync(w, { recursive: true, force: true }); }
});

test('failed linear-brain create: retry is allowed, other commands blocked until it succeeds', opts, () => {
  const w = world(), s = sid();
  try {
    writeFileSync(`/tmp/notion-create-failed-${s}`, 'FAILED\n');
    assert.equal(run(w, 'notion-create-block.sh', bash(s, 'ls')).rc, 2);
    assert.equal(run(w, 'notion-create-block.sh', bash(s, 'node scripts/linear-brain.js create "t" --park r')).rc, 0);
    assert.equal(run(w, 'notion-create-block.sh', bash(s, 'node scripts/linear-session.js claim --issue=BRO-1')).rc, 0);
  } finally { cleanup(s); rmSync(w, { recursive: true, force: true }); }
});

test('session-stop recognises Linear closure (no stale NO NOTION UPDATE warning)', opts, () => {
  const w = world(), s = sid();
  try {
    const t = path.join(w, 't.jsonl');
    writeFileSync(t, 'node scripts/linear-brain.js update BRO-2470 --state Done\n');
    const r = spawnSync('bash', [path.join(HOOKS, 'session-stop.sh')], {
      input: JSON.stringify({ session_id: s, transcript_path: t }),
      env: { PATH: process.env.PATH, HOME: w, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, cwd: w, encoding: 'utf8', timeout: 30000,
    });
    assert.doesNotMatch(r.stdout + r.stderr, /NO (NOTION|BOARD) UPDATE|STILL 'IN PROGRESS'|STILL OPEN/);
  } finally { cleanup(s); rmSync(w, { recursive: true, force: true }); }
});

test('every hook that writes the create-failed breadcrumb can also clear it on READ-ONLY', opts, () => {
  const writers = readdirSync(HOOKS).filter((f) => f.endsWith('.sh'))
    .filter((f) => /echo[^\n]*>\s*"?\$?\{?FAIL_BREADCRUMB|>\s*"?\/tmp\/notion-create-failed/.test(readFileSync(path.join(HOOKS, f), 'utf8')));
  assert.deepEqual(writers, ['notion-create-verify.sh']);
  assert.match(readFileSync(path.join(HOOKS, writers[0]), 'utf8'), /Notion is READ-ONLY[\s\S]{0,80}rm -f "\$FAIL_BREADCRUMB"/);
});
