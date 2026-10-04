// BRO-2311: infra-plan-review-gate.sh parses the Bash COMMAND STRING, so
// `python3 patch.py` where patch.py does Path.write_text() on a gated file is
// invisible to it. infra-post-write-audit.sh (PostToolUse) closes that class by
// asking git what changed, whatever wrote it. These cases reproduce the bypass
// end to end against the REPO hook copies in a throwaway git repo.
// (The card's second instance, claude-sync skipping the hook-test gate when the
// commit predates the push, lives in ~/.claude and is covered there by
// hooks/tests/git-pre-push-hook-tests.sh.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2311-'));
const fakeHome = path.join(scratch, 'home'); // no ~/.claude/hooks, so the repo copies do not self-skip
fs.mkdirSync(fakeHome);
const repo = path.join(scratch, 'repo');
fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(repo, 'scripts', 'lib'), { recursive: true });
spawnSync('git', ['init', '-q', repo]);
// No background housekeeping in the scratch repo, so nothing writes
// .git/objects after the last test.
for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false']]) {
  spawnSync('git', ['-C', repo, 'config', k, v]);
}
const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
git('add', '-A');
git('commit', '-q', '-m', 'fixture');
// Best-effort: every assertion has run by now. A land run failed here with all
// subtests ok on "ENOTEMPTY: rmdir .../repo/.git/objects" (2026-10-04); a
// leftover temp dir is not a test failure.
test.after(() => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (e) {
    console.warn(`[infra-plan-review-gate-bypass] scratch cleanup left ${scratch}: ${e.code || e.message}`);
  }
});

const GATED = 'scripts/lib/review-gate.mjs';
const patcher = path.join(scratch, 'patch-hook.py');
fs.writeFileSync(patcher, `import pathlib\np = pathlib.Path(${JSON.stringify(path.join(repo, GATED))})\np.write_text(p.read_text() + "\\n// patched\\n")\n`);

function run(hook, sessionId, command) {
  const tmp = fs.mkdtempSync(path.join(scratch, 'tmp-'));
  const r = spawnSync('bash', [path.join(HOOKS, hook)], {
    cwd: repo, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ session_id: sessionId, tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, HOME: fakeHome, TMPDIR: tmp, INFRA_REVIEW_GATE_DISABLE: '', INFRA_POST_AUDIT_DISABLE: '' },
  });
  return { status: r.status, stderr: r.stderr || '' };
}

test('python script write: pre-hoc gate cannot see it, post-write audit catches it', () => {
  const cmd = `python3 ${patcher}`;
  // Pre-hoc: the gated path never appears in the command string, so it passes.
  assert.equal(run('infra-plan-review-gate.sh', 'sid-a', cmd).status, 0);
  // Clean tree: audit has nothing to report.
  assert.equal(run('infra-post-write-audit.sh', 'sid-a', cmd).status, 0);
  const w = spawnSync('python3', [patcher], { encoding: 'utf8' });
  assert.equal(w.status, 0, w.stderr);
  // Post-hoc: git sees the modified gated file regardless of what wrote it.
  const r = run('infra-post-write-audit.sh', 'sid-a', cmd);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /review-gate\.mjs/);
  assert.match(r.stderr, /record-plan/);
});

test('post-write audit: a recorded plan review for the session, or NO-PLAN-REVIEW, clears it', () => {
  const rec = spawnSync('node', ['scripts/lib/review-gate.mjs', '--query=record-plan', '--reviewer=second-opinion',
    '--result=pass', '--session-id=sid-ok'], { cwd: repo, encoding: 'utf8' });
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(run('infra-post-write-audit.sh', 'sid-ok', 'ls').status, 0);
  assert.equal(run('infra-post-write-audit.sh', 'sid-b',
    'ls # NO-PLAN-REVIEW: fixture write in a throwaway test repo').status, 0);
});

test('post-write audit: a non-gated write (any ingress) is not flagged', () => {
  git('checkout', '-q', '--', GATED);
  fs.mkdirSync(path.join(repo, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'notes', 'scratch.txt'), 'x');
  assert.equal(run('infra-post-write-audit.sh', 'sid-c', 'python3 other.py').status, 0);
});
