#!/usr/bin/env node
// scripts/lib/dispatch-repo-root.test.mjs — BRO-2668: REPO in bsc-next.js and
// linear-next.js was a hardcoded dev-machine path used directly at ~10 call
// sites (dispatch-claim dirs, succession locks, the queue path, subprocess
// cwd, ...). BRO-2647 fixed only the two resolvePathCheck() call sites by
// wrapping them in resolveCanonicalRepoRoot(); this ticket routes REPO
// itself through that same function so every other call site is correct too.
//
// Deliberately does NOT re-implement or wrap resolveCanonicalRepoRoot() —
// it's already pure and already covered by scripts/lib/dispatch-guards.test.mjs
// (see its "BRO-2647: resolveCanonicalRepoRoot" section). This file exists
// because BRO-2668's acceptance criteria names this exact test path; per
// CLAUDE.md rule 15 it require()s the real function rather than copying its
// logic. Cases 1-2 duplicate dispatch-guards.test.mjs's existing coverage of
// the same function (harmless — same function, same behavior); case 3 is new
// coverage this ticket specifically asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveCanonicalRepoRoot } = require('./dispatch-guards.js');

test('resolveCanonicalRepoRoot: hardcoded path present returns it unchanged (the dev-machine case)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2668-repo-root-'));
  try {
    assert.equal(resolveCanonicalRepoRoot(tmp, '/some/unrelated/module/dir'), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCanonicalRepoRoot: hardcoded path absent falls back to moduleDir/.. (the CI case)', () => {
  const bogus = path.join(os.tmpdir(), 'bro-2668-definitely-absent-' + Date.now());
  const moduleDir = '/home/runner/work/Broadwayscore/Broadwayscore/scripts';
  assert.equal(resolveCanonicalRepoRoot(bogus, moduleDir), path.resolve(moduleDir, '..'));
});

test('resolveCanonicalRepoRoot: invoked from inside a worktree still returns the main checkout, not the worktree root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2668-repo-root-worktree-'));
  try {
    // Shaped like a real worktree's scripts/ dir: <repo>/.claude/worktrees/<name>/scripts.
    // A naive path.resolve(moduleDir, '..') from here lands on the WORKTREE root,
    // not the main checkout -- the exact failure mode BRO-2668 flagged as an open
    // question. resolveCanonicalRepoRoot never reaches that branch as long as the
    // hardcoded main-checkout path exists on disk, which it always does on the dev
    // machine (worktree or not) -- this pins that property.
    const worktreeScriptsDir = path.join(tmp, '.claude', 'worktrees', 'some-worktree', 'scripts');
    const result = resolveCanonicalRepoRoot(tmp, worktreeScriptsDir);
    assert.equal(result, tmp);
    assert.notEqual(result, path.resolve(worktreeScriptsDir, '..'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Adversarial review finding (Codex, BRO-2668): the 3 tests above only prove
// resolveCanonicalRepoRoot() itself behaves correctly — they never look at
// bsc-next.js/linear-next.js's own REPO declaration, so reverting either
// script's REPO back to the bare hardcoded literal would leave every test in
// this file green (the resolved value and the literal are byte-identical on
// the dev machine, so an equality check on REPO's VALUE can't tell them
// apart either — only a structural check on how it's computed can). This is
// the same class of gap dispatch-guards.test.mjs:398 already closes for
// resolvePathCheck()'s call sites; this closes it for REPO's own assignment.
test('bsc-next.js and linear-next.js each resolve REPO through resolveCanonicalRepoRoot, not a bare literal', () => {
  for (const file of ['../bsc-next.js', '../linear-next.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const repoLine = /^const REPO = (.+);$/m.exec(src);
    assert.ok(repoLine, `${file}: expected a top-level "const REPO = ...;" declaration`);
    assert.doesNotMatch(repoLine[1], /^['"]/,
      `${file}: REPO must not be a bare string literal again — every REPO-derived path ` +
      `(DISPATCH_CLAIM_DIR, SUCCESSION_LOCK_DIR, QUEUE_PATH, subprocess cwd, ...) would ` +
      `reproduce BRO-2647's CI-only failure mode (BRO-2668)`);
    // Both files destructure resolveCanonicalRepoRoot from dispatch-guards.js
    // TWICE — once (possibly aliased, to avoid a duplicate top-level binding)
    // for REPO's own line, and again unaliased in the pre-existing shared
    // guard destructure further down. Collect every local name it could
    // resolve to from EITHER block, in file order, rather than assuming which
    // one comes first (that order differs between the two files).
    const destructureRe = new RegExp(
      String.raw`const\s*\{[^}]*resolveCanonicalRepoRoot(?:\s*:\s*(\w+))?[^}]*\}\s*=\s*require\(['"]\.\/lib\/dispatch-guards\.js['"]\)`,
      'g',
    );
    const localNames = [];
    let dm;
    while ((dm = destructureRe.exec(src)) !== null) localNames.push(dm[1] || 'resolveCanonicalRepoRoot');
    assert.ok(localNames.length > 0,
      `${file}: expected at least one require('./lib/dispatch-guards.js') destructure naming resolveCanonicalRepoRoot`);
    assert.ok(localNames.some((name) => new RegExp(`^${name}\\(`).test(repoLine[1])),
      `${file}: REPO's RHS ("${repoLine[1]}") must call one of [${localNames.join(', ')}] — the local ` +
      `name(s) resolveCanonicalRepoRoot resolves to in this file — a revert or drift here reproduces ` +
      `BRO-2647's CI-only failure for every REPO-derived path (BRO-2668)`);
  }
});
