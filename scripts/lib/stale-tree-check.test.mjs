// BRO-7078: land.yml copies main's stale-tree-check.mjs ALONE into a temp dir
// and runs it on the branch tree. A non-builtin import would resolve to the
// branch's (possibly stale) siblings, or to nothing, and the check would fail
// to load in exactly the stale-tree case it exists for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'stale-tree-check.mjs');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

test('imports only node: builtins (no sibling or package imports)', () => {
  const text = fs.readFileSync(SRC, 'utf8');
  const specs = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, 'parsed no imports at all');
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), []);
});

test('a lone copy in an empty dir runs and flags a stale-tree squash, exit 0', () => {
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-lone-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-repo-'));
  try {
    fs.copyFileSync(SRC, path.join(lone, 'stale-tree-check.mjs'));
    const sh = (cmd) => { const r = spawnSync('bash', ['-c', cmd], { cwd: repo, env: ENV, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    sh('git init -q -b main . && for i in 0 1 2 3; do echo 0 > m$i.ts; done && git add -A && git commit -qm init && git branch feat');
    sh('for i in 0 1 2 3; do echo $((i+1)) > m$i.ts; done && git commit -qam "main moves on"');
    sh('git checkout -q feat && echo fix > g.txt && git add g.txt && git commit -qm fix && git reset -q --soft main && git commit -qm squash');
    const r = spawnSync(process.execPath, [path.join(lone, 'stale-tree-check.mjs'), '--ci-stale', '--base', 'main', '--tip', 'feat', '--cwd', repo], { env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^::warning::stale-tree revert: 4 of the 5 files/m);
    assert.match(r.stdout, /^stale_tree=fail$/m);
  } finally {
    fs.rmSync(lone, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
