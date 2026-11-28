import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveCheckPaths } = require('../../scripts/lib/check-paths.js');

// BRO-2625: a brand-new nested deliverable (neither file nor its parent dir exist) is a
// legitimate to-be-created artifact when its nearest existing ancestor is under an allowed root.
function repo(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-'));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test('immediate parent exists: accepted as new path (unchanged)', () => {
  const r = resolveCheckPaths('test -f src/a.ts', { repoRoot: repo(['src']) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.newPaths, ['src/a.ts']);
});

test('2+ level new directory under an allowed root passes', () => {
  const r = resolveCheckPaths('test -f src/new-feature/index.ts', { repoRoot: repo(['src']) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.newPaths, ['src/new-feature/index.ts']);
  const r3 = resolveCheckPaths('test -f scripts/lib/newdir/x.js', { repoRoot: repo(['scripts/lib']) });
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.newPaths, ['scripts/lib/newdir/x.js']);
});

test('two missing levels still fail closed', () => {
  const r = resolveCheckPaths('test -f scripts/lib/deep/er/x.js', { repoRoot: repo(['scripts/lib']) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /directory that does not exist/);
});

test('tests/ keeps the veto: an invented tests/<dir>/ is the #171 phantom', () => {
  const root = repo(['tests/unit']);
  const r = resolveCheckPaths('node --test tests/guards/review-write-guard.test.mjs', { repoRoot: root });
  assert.equal(r.ok, false);
});

test('allowed root absent entirely still fails closed', () => {
  const r = resolveCheckPaths('test -f src/new-feature/index.ts', { repoRoot: repo([]) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /directory that does not exist/);
});

test('non-allowlisted root fails closed', () => {
  const r = resolveCheckPaths('test -f foo/bar/x.js', { repoRoot: repo(['foo']) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /directory that does not exist/);
});

test('existing directory named as the file still vetoed', () => {
  const r = resolveCheckPaths('test -f src/new', { repoRoot: repo(['src/new']) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /names a directory/);
});

test('an ancestor that is a FILE does not qualify', () => {
  const root = repo(['src']);
  fs.writeFileSync(path.join(root, 'src', 'blocker'), 'x');
  const r = resolveCheckPaths('test -f src/blocker/deep/x.ts', { repoRoot: root });
  assert.equal(r.ok, false);
});

test('directory-shaped or traversal paths are not forgiven as new files', () => {
  const root = repo(['scripts']);
  for (const cmd of ['test -f scripts/a/b/', 'test -f scripts/newdir/.', 'node --test scripts/../tests/phantom/x.test.mjs']) {
    assert.equal(resolveCheckPaths(cmd, { repoRoot: root }).ok, false, cmd);
  }
});
