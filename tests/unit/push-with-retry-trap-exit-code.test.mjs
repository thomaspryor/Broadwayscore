import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'push-with-retry.sh');

/**
 * BRO-2909. scripts/lib/push-with-retry.sh registers its EXIT trap BEFORE
 * restore_head_if_moved() is defined, deliberately: nothing may sit between
 * push_mutex_acquire and the trap, or a failing command in that window leaks
 * the mutex (task #556). A bash trap body is a string evaluated when the trap
 * FIRES, so that is normally fine.
 *
 * It stops being fine the moment something EXITS inside the gap. The BRO-142
 * stale-marker refusal does exactly that. With `set -euo pipefail`, the trap
 * then dies at "restore_head_if_moved: command not found" before reaching
 * `exit $rc`, and a deliberate `exit 1` reaches every caller as 127.
 *
 * That is the worst shape of failure for a shared primitive: the refusal
 * message still prints, so a human reading the log sees the right words, while
 * any caller branching on the exit code sees command-not-found. Every workflow
 * and every parallel session calls this script.
 *
 * This test is BEHAVIOURAL on purpose. A static scan for "an exit between a
 * trap registration and the definition of a function that trap names" cannot
 * tell that the call is conditional, so it would false-positive forever. This
 * runs the real script against a real repository in the real failing state.
 */

/** A throwaway git repo with a planted stale MERGE_HEAD. */
function makeRepoWithStaleMarker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwr-trap-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '--quiet', '--initial-branch=main']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  run(['add', 'file.txt']);
  run(['commit', '--quiet', '-m', 'initial']);

  // The precondition the BRO-142 gate refuses on: a marker left behind by an
  // earlier interrupted merge. A conflicted merge-worktree-to-main.sh run
  // produces exactly this in the shared checkout.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), head + '\n');
  return dir;
}

function runPushWithRetry(cwd) {
  return spawnSync('bash', [SCRIPT], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, PUSH_MUTEX_DISABLED: '1', CI: '' },
    timeout: 120000,
  });
}

test('the stale-marker refusal exits 1, not 127 — the trap must not die on an undefined function', () => {
  const dir = makeRepoWithStaleMarker();
  try {
    const res = runPushWithRetry(dir);
    const output = `${res.stdout || ''}${res.stderr || ''}`;

    // Prove we actually reached the gate we think we did. Without this the
    // assertions below could pass because the script failed somewhere else
    // entirely for an unrelated reason — a green test proving nothing.
    assert.match(
      output,
      /refusing to fetch\/rebase\/merge on top of it|MERGE_HEAD found before this run/,
      `expected the BRO-142 stale-marker refusal, got status ${res.status}:\n${output.slice(0, 1500)}`
    );

    assert.doesNotMatch(
      output,
      /restore_head_if_moved: command not found|command not found/,
      'the EXIT trap called a function that is not defined yet. The trap is registered before ' +
        'restore_head_if_moved() on purpose (task #556), so the call inside it MUST stay guarded ' +
        'by `command -v restore_head_if_moved >/dev/null 2>&1 &&`.'
    );

    assert.notEqual(
      res.status,
      127,
      'exit 127 means the trap died at "command not found" and never reached `exit $rc`, so the ' +
        'deliberate refusal was reported to every caller as command-not-found (BRO-2909)'
    );

    assert.equal(
      res.status,
      1,
      `the stale-marker refusal must exit 1. Got ${res.status}.\n${output.slice(0, 1500)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the trap body still guards the restore call (pins the fix against a tidy-up)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const trapLine = src.split('\n').find((l) => l.startsWith('trap ') && l.includes('EXIT'));
  assert.ok(trapLine, 'no EXIT trap found in push-with-retry.sh — was it renamed or removed?');

  // Order matters: the guard has to come BEFORE the call in the && chain.
  const guardAt = trapLine.indexOf('command -v restore_head_if_moved');
  const callAt = trapLine.indexOf('restore_head_if_moved "trap-nonzero-exit-');
  assert.ok(
    guardAt !== -1,
    `the EXIT trap calls restore_head_if_moved without a \`command -v\` guard. It is registered ` +
      `before that function is defined (task #556), so an exit inside the gap kills the trap and ` +
      `masks the real exit code as 127 (BRO-2909). Trap line:\n  ${trapLine}`
  );
  assert.ok(
    callAt === -1 || guardAt < callAt,
    `the \`command -v\` guard must come BEFORE the restore call in the && chain. Trap line:\n  ${trapLine}`
  );
});

test('the hazard this guards is real: the trap is still registered before the definition', () => {
  const lines = fs.readFileSync(SCRIPT, 'utf-8').split('\n');
  const trapIdx = lines.findIndex((l) => l.startsWith('trap ') && l.includes('EXIT'));
  const defIdx = lines.findIndex((l) => /^restore_head_if_moved\(\)/.test(l));
  assert.ok(trapIdx >= 0 && defIdx >= 0, 'could not locate both the EXIT trap and the definition');

  // If someone ever DOES safely hoist the definition above the trap, this test
  // should fail loudly rather than silently keep asserting a guard nobody needs
  // any more — at which point delete the guard and this file together, and read
  // BRO-2909 first: hoisting also has to move SCRIPT_ENTRY_HEAD,
  // RESTORE_BASE_HEAD and _head_is_descendant, or `set -u` aborts on the
  // unbound read before the function's own guard can return 0.
  assert.ok(
    trapIdx < defIdx,
    'restore_head_if_moved() is now defined BEFORE the EXIT trap, so the guard this file pins may ' +
      'no longer be needed. Do not just delete it — see BRO-2909 for what else has to move.'
  );
});
