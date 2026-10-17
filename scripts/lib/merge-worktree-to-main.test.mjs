// scripts/lib/merge-worktree-to-main.test.mjs — BRO-3595.
//
// pop_stash_safely() in scripts/merge-worktree-to-main.sh must resolve a stash-pop
// conflict on a brand-new (never-committed) auto-gen path without swallowing the
// `git checkout HEAD -- <path>` failure and without leaving unresolved index entries.
// The scenario is driven against throwaway repos by the existing shell regression
// test; this wrapper runs it under node --test so the card's VERIFY command and
// `npm run test:lib` both exercise it.
//
// Run: node --test scripts/lib/merge-worktree-to-main.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'merge-worktree-to-main.stash-pop-head-missing-path.test.sh');

test('stash-pop conflict on a path HEAD does not track is unstaged and removed, stash dropped', () => {
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 170000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(r.status, 0, `shell regression test failed:\n${out.slice(-2000)}`);
  assert.match(out, /PASSED/);
});
