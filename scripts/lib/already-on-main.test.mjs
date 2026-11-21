import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { alreadyOnMain } = createRequire(import.meta.url)('./already-on-main.js');

test('a branch whose commits are all on origin/main needs no push audits; one real commit does', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aom-'));
  const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.email=t@e.x', '-c', 'user.name=T', ...a], { encoding: 'utf8' }).trim();
  try {
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(d, 'a'), '1'); g('add', '-A'); g('commit', '-qm', 'a');
    const old = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(d, 'a'), '2'); g('commit', '-qam', 'b');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(alreadyOnMain(old, d), true, 'an ancestor of origin/main has nothing new');
    g('checkout', '-q', '-b', 'claude/x');
    fs.writeFileSync(path.join(d, 'a'), '3'); g('commit', '-qam', 'c');
    assert.equal(alreadyOnMain(g('rev-parse', 'HEAD'), d), false, 'a real local commit still gets audited');
    assert.equal(alreadyOnMain('nonsense', d), false, 'bad input fails open to auditing');
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
});
