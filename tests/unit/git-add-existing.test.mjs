/**
 * Tests for scripts/lib/git-add-existing.sh — independent per-path staging that
 * survives a missing pathspec (the git-add atomicity trap).
 *
 * The regression this locks in: `git add A B C` aborts entirely (exit 128, stages
 * NOTHING) if any of A/B/C matches no file. The helper must stage every existing
 * path even when others are missing, handle directories and unmatched globs, support
 * --force for gitignored outputs, and never return non-zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.resolve(fileURLToPath(new URL('../../scripts/lib/git-add-existing.sh', import.meta.url)));

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-add-existing-'));
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe' }).toString();
  run('git init -q');
  run('git config user.email t@t.t');
  run('git config user.name t');
  return { dir, run };
}
function staged(run) {
  return run('git diff --cached --name-only').trim().split('\n').filter(Boolean).sort();
}
function addExisting(dir, args) {
  // Caller's shell expands globs — mirror that by running through bash -c.
  return execSync(`bash ${HELPER} ${args}`, { cwd: dir, stdio: 'pipe' });
}

test('stages multiple existing files', () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'b.json'), '{}');
  addExisting(dir, 'a.json b.json');
  assert.deepEqual(staged(run), ['a.json', 'b.json']);
});

test('THE REGRESSION: a missing pathspec does NOT block the existing ones', () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'present.json'), '{}');
  // missing.json deliberately not created — plain `git add present.json missing.json`
  // would exit 128 and stage NOTHING. The helper must still stage present.json.
  addExisting(dir, 'present.json missing.json');
  assert.deepEqual(staged(run), ['present.json']);
});

test('stages a directory pathspec with changes', () => {
  const { dir, run } = makeRepo();
  fs.mkdirSync(path.join(dir, 'audit'));
  fs.writeFileSync(path.join(dir, 'audit', 'x.json'), '{}');
  addExisting(dir, 'audit/ missing.json');
  assert.deepEqual(staged(run), ['audit/x.json']);
});

test('unmatched glob literal is skipped, siblings still staged', () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'keep.json'), '{}');
  // No *.social.json files exist → bash leaves the literal pattern → helper skips it.
  addExisting(dir, "keep.json 'public/data/shows/*.social.json'");
  assert.deepEqual(staged(run), ['keep.json']);
});

test('matched glob stages all matches alongside a sibling', () => {
  const { dir, run } = makeRepo();
  fs.mkdirSync(path.join(dir, 'd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'd', 'one.social.json'), '{}');
  fs.writeFileSync(path.join(dir, 'd', 'two.social.json'), '{}');
  fs.writeFileSync(path.join(dir, 'sib.json'), '{}');
  addExisting(dir, 'sib.json d/*.social.json');
  assert.deepEqual(staged(run), ['d/one.social.json', 'd/two.social.json', 'sib.json']);
});

test('--force stages a gitignored file', () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.json\n');
  fs.writeFileSync(path.join(dir, 'secret.json'), '{}');
  fs.writeFileSync(path.join(dir, 'plain.json'), '{}');
  addExisting(dir, '--force secret.json plain.json');
  assert.deepEqual(staged(run), ['plain.json', 'secret.json']);
});

test('exits 0 even when nothing matches', () => {
  const { dir } = makeRepo();
  // Should not throw — every path missing, helper still returns 0.
  assert.doesNotThrow(() => addExisting(dir, 'nope1.json nope2.json'));
});
