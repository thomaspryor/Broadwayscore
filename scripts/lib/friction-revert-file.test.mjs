import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { revertFile } from './friction-revert-file.js';

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-revert-'));
  sh('git init -q', root);
  sh('git config user.email t@t.t', root);
  sh('git config user.name t', root);
  return root;
}

test('revertFile restores a HEAD-tracked file to its committed content', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'existing.txt'), 'committed-content\n');
  sh('git add -A && git commit -qm base', root);

  fs.writeFileSync(path.join(root, 'existing.txt'), 'BROKEN-PATCH\n');
  revertFile('existing.txt', root);

  assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'committed-content\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('revertFile removes a file HEAD never had (BRO-3595 cousin: newly-added, never committed)', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  sh('git add -A && git commit -qm base', root);

  fs.writeFileSync(path.join(root, 'new-file.txt'), 'initial\n');
  sh('git add new-file.txt', root);
  fs.writeFileSync(path.join(root, 'new-file.txt'), 'BROKEN-PATCH\n');

  revertFile('new-file.txt', root);

  assert.equal(fs.existsSync(path.join(root, 'new-file.txt')), false);
  const status = execSync('git status --porcelain', { cwd: root }).toString();
  assert.equal(status.includes('new-file.txt'), false, `expected no dangling index entry, got: ${status}`);
  fs.rmSync(root, { recursive: true, force: true });
});
