// BRO-7703: the daily sweep-image-variants workflow generated sm/ list variants and then
// died at `git add` ("pathspec ... did not match any files") whenever the new files were
// all in brand-new sm/ folders. That left regional shows added since the last good run
// with 404ing thumbnails on the live site (`/sm/thumbnail.webp.webp`).
//
// This runs the workflow's REAL `git add` line (read from the yml, not copied here)
// against a throwaway repo whose only new files are in a new sm/ folder, and asserts
// they get staged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const yml = readFileSync(new URL('../../.github/workflows/sweep-image-variants.yml', import.meta.url), 'utf8');

function addLine() {
  const lines = yml.split('\n').filter((l) => /^\s*git add -A -- .*\/sm/.test(l));
  assert.equal(lines.length, 1, 'sweep workflow must keep exactly one `git add -A -- <...>/sm...` line');
  return lines[0].trim();
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('sweep stages variants that sit in a brand-new sm/ folder', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sweep-stage-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    // One show that already has a tracked sm/ folder, one that does not.
    mkdirSync(join(repo, 'public/images/shows/old-show/sm'), { recursive: true });
    writeFileSync(join(repo, 'public/images/shows/old-show/poster.webp'), 'x');
    writeFileSync(join(repo, 'public/images/shows/old-show/sm/poster.webp.webp'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');
    mkdirSync(join(repo, 'public/images/shows/new-regional-show/sm'), { recursive: true });
    writeFileSync(join(repo, 'public/images/shows/new-regional-show/thumbnail.webp'), 'x');
    writeFileSync(join(repo, 'public/images/shows/new-regional-show/sm/thumbnail.webp.webp'), 'x');

    // Only the new sm/ folder is untracked (the originals are, but the add pathspec must not need them).
    execFileSync('bash', ['-ec', addLine()], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    const staged = git(repo, 'diff', '--cached', '--name-only').trim().split('\n');
    assert.deepEqual(staged, ['public/images/shows/new-regional-show/sm/thumbnail.webp.webp']);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
