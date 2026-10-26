#!/usr/bin/env node
'use strict';

/**
 * Shared contract for `git worktree list --porcelain` (BRO-2641).
 * Branches omit refs/heads/; detached/bare entries have branch=null.
 * An unlocked entry has lockReason=null; a reasonless lock has lockReason=''.
 * Quoted/escaped Git values stay verbatim, as in the original callers.
 * Unknown fields are ignored, and state never carries between worktrees.
 */
function parseWorktreePorcelain(porcelain) {
  const entries = [];
  let entry = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      entry = { path: line.slice(9), branch: null, locked: false, lockReason: null };
      entries.push(entry);
    } else if (line === '') {
      entry = null;
    } else if (entry) {
      if (line.startsWith('branch refs/heads/')) {
        entry.branch = line.slice('branch refs/heads/'.length);
      } else if (line === 'detached' || line === 'bare') {
        entry.branch = null;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        entry.locked = true;
        entry.lockReason = line.slice('locked'.length).trim();
      }
    }
  }
  return entries;
}

// Shell adapter: git worktree list --porcelain | node worktree-lock-parse.js
// Four NUL-terminated fields per record preserve empty fields and whitespace
// when gc-merged-worktrees.sh reads path, branch, is_locked and locked_reason.
if (require.main === module) {
  const { readFileSync } = require('fs');
  const entries = parseWorktreePorcelain(readFileSync(0, 'utf8'));
  process.stdout.write(entries.map(({ path, branch, locked, lockReason }) =>
    [path, branch || '', locked ? '1' : '0', lockReason || '', ''].join('\0')
  ).join(''));
}

module.exports = { parseWorktreePorcelain };
