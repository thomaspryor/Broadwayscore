// BRO-2463: audit/feedback-request-ledger.json and audit/express-retry-queue.json
// are optInReconcile:false, so (like alert-digest-queue.json, BRO-257) a clean
// `git rebase -X theirs` append/append hunk drops the remote writer's entry
// without ever reaching push-with-retry.sh's conflict case arm. push-with-retry
// must therefore call reconcile-merged-json.js for them unconditionally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CORE_DATA_MERGE_REGISTRY } = require('../../scripts/lib/core-data-merge-registry.js');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RECONCILE = path.join(REPO, 'scripts/lib/reconcile-merged-json.js');
const PUSH = fs.readFileSync(path.join(REPO, 'scripts/lib/push-with-retry.sh'), 'utf8');

const EXPRESS = { file: 'data/audit/express-retry-queue.json' };
const CASES = [
  { file: 'data/audit/express-retry-queue.json', e2eOnly: true, mk: (id) => ({ showId: id, market: 'broadway', queuedAt: `2026-10-13T00:00:0${id.length}Z`, dueAt: '2026-10-13T01:00:00Z', attempted: false }) },
  { file: 'data/audit/feedback-request-ledger.json', mk: (id) => ({ key: `req-${id}`, status: 'open' }) },
];

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

for (const c of CASES) {
  if (!c.e2eOnly) test(`push-with-retry.sh reconciles ${c.file} unconditionally`, () => {
    const line = PUSH.split('\n').find((l) => l.includes('reconcile-merged-json.js') && l.includes('"origin/$PULL_BRANCH"') && l.includes('data/audit/alert-digest-queue.json'));
    assert.ok(line, 'targeted reconcile call not found');
    assert.ok(line.includes(c.file), `${c.file} missing from the targeted reconcile call`);
  });

  test(`merger restores the remote append a clean -X theirs rebase drops (${c.file})`, () => {
    const entry = CORE_DATA_MERGE_REGISTRY.find((e) => c.file.endsWith(e.file));
    assert.ok(entry && entry.merge, 'registered merger');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2463-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
      const f = path.join(dir, c.file);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const write = (arr) => fs.writeFileSync(f, JSON.stringify({ entries: arr }, null, 2) + '\n');
      write([]); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
      git(dir, 'checkout', '-qb', 'local');
      write([c.mk('bb')]); git(dir, 'commit', '-qam', 'local append');
      git(dir, 'checkout', '-q', 'main');
      write([c.mk('a')]); git(dir, 'commit', '-qam', 'remote append');
      git(dir, 'checkout', '-q', 'local');
      git(dir, 'rebase', '-X', 'theirs', 'main');
      const after = JSON.parse(fs.readFileSync(f, 'utf8')).entries;
      assert.equal(after.length, 1, 'precondition: -X theirs silently dropped the remote entry');
      execFileSync('node', [RECONCILE, 'main', c.file], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const merged = JSON.parse(fs.readFileSync(f, 'utf8')).entries;
      assert.equal(merged.length, 2, 'both writers survive after reconcile');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('express-retry-queue.json stays OUT of the unconditional call until it has a three-way merger (pruned entries would be resurrected)', () => {
  const line = PUSH.split('\n').find((l) => l.includes('reconcile-merged-json.js') && l.includes('data/audit/alert-digest-queue.json'));
  assert.ok(line && !line.includes(EXPRESS.file));
});
