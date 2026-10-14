#!/usr/bin/env node
/**
 * check-worktree-collision.js — real-git wrapper around
 * scripts/lib/duplicate-dispatch-guard.js's evaluateWorktreeEntry.
 *
 * Given a worktree NAME (the same value passed to EnterWorktree's `name`),
 * finds it in `git worktree list --porcelain` and reports whether resuming
 * it is safe. Intended as a PreToolUse hook body: a hook matching the
 * EnterWorktree tool can call this before the tool runs and refuse the call
 * on a locked or dirty same-name worktree (task #542 — the "resumed as-is"
 * collision that let two agents write the same four files concurrently).
 *
 * Usage: node scripts/check-worktree-collision.js <name>
 * Exit 0 + "ALLOW: <reason>" on stdout when safe.
 * Exit 1 + "REFUSE: <reason>" on stdout when unsafe.
 * Exit 3 + "ERROR: <message>" on stdout for anything unexpected (bad git
 * output shape, thrown exception, etc). A crash must NEVER surface as exit 1
 * — that's indistinguishable from a genuine REFUSE and would flip the
 * hook's fail-open guarantee into wedging every EnterWorktree call on any
 * regression here (ship-check finding, ships with this fix).
 */

'use strict';

const { execFileSync } = require('child_process');
const { evaluateWorktreeEntry } = require('./lib/duplicate-dispatch-guard');
const { hasHelpFlag } = require('./lib/cli-help');

function getWorktreeState(name, repoRoot) {
  let porcelain;
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    // Can't even list worktrees — fail open (evaluateWorktreeEntry(null) allows).
    return null;
  }

  const targetPath = `${repoRoot}/.claude/worktrees/${name}`;
  const blocks = porcelain.trim().split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    const pathLine = lines.find(l => l.startsWith('worktree '));
    if (!pathLine) continue;
    const wtPath = pathLine.slice('worktree '.length).trim();
    if (wtPath !== targetPath) continue;

    const lockLine = lines.find(l => l.startsWith('locked'));
    const locked = Boolean(lockLine);
    const lockReason = lockLine ? lockLine.slice('locked'.length).trim() : null;

    let dirty = false;
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: wtPath,
        encoding: 'utf8',
      });
      dirty = status.trim().length > 0;
    } catch {
      // If we can't read status, treat as dirty — fail toward refusing a
      // resume rather than silently allowing an unknown state.
      dirty = true;
    }

    return { name, exists: true, locked, lockReason, dirty };
  }

  return { name, exists: false };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('usage: node scripts/check-worktree-collision.js <name>\nExits 0/ALLOW, 1/REFUSE, or 3/ERROR — see file header. Does not modify anything.');
    process.exit(0);
  }
  const name = process.argv[2];
  if (!name) {
    console.error('usage: check-worktree-collision.js <name>');
    process.exit(2);
  }
  const repoRoot = process.env.BROADWAYSCORE_REPO || `${process.env.HOME}/Broadwayscore`;
  const state = getWorktreeState(name, repoRoot);
  const verdict = evaluateWorktreeEntry(state);
  console.log(`${verdict.allow ? 'ALLOW' : 'REFUSE'}: ${verdict.reason}`);
  process.exit(verdict.allow ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // Any unexpected exception (bad git output shape, missing module, etc.)
    // must exit with a code distinct from both 0 (allow) and 1 (refuse) —
    // otherwise a crash reads as a genuine REFUSE and the hook wedges every
    // EnterWorktree call, the opposite of its documented fail-open contract.
    console.log(`ERROR: ${err && err.message}`);
    process.exit(3);
  }
}

module.exports = { getWorktreeState };
