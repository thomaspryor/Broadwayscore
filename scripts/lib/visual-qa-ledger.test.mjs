#!/usr/bin/env node
// scripts/lib/visual-qa-ledger.test.mjs — ledger format + push-allowed walker.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { recordApproval, queryPushAllowed } from './visual-qa-ledger.mjs';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // initial commit on main
  writeFileSync(join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  // fake an "origin" remote in the same repo so origin/main exists
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function commit(dir, file, body, msg) {
  const full = join(dir, file);
  mkdirSync(join(dir, file.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
  writeFileSync(full, body);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('ledger records and reads back entries', () => {
  const { dir, cleanup } = initRepo();
  try {
    const sha = commit(dir, 'src/components/Foo.tsx', '<div/>', 'feat: foo');
    recordApproval(dir, { branch: 'feat/foo', commitSha: sha, contentHash: 'aaaa', sessionId: 's1' });
    const ledgerText = readFileSync(join(dir, '.claude/visual-qa/approvals.jsonl'), 'utf8');
    assert.match(ledgerText, /aaaa/);
    assert.match(ledgerText, new RegExp(sha));
  } finally { cleanup(); }
});

test('push-allowed: no UI commits → allowed (no-op range)', () => {
  const { dir, cleanup } = initRepo();
  try {
    commit(dir, 'docs/notes.md', 'docs\n', 'docs: notes');
    const r = queryPushAllowed(dir);
    assert.equal(r.allowed, true);
  } finally { cleanup(); }
});

test('push-allowed: UI commit without ledger entry → blocked', () => {
  const { dir, cleanup } = initRepo();
  try {
    commit(dir, 'src/components/Bar.tsx', '<div/>', 'feat: bar');
    const r = queryPushAllowed(dir);
    assert.equal(r.allowed, false);
    assert.equal(r.missing.length, 1);
  } finally { cleanup(); }
});

test('push-allowed: UI commit with ledger entry → allowed', () => {
  const { dir, cleanup } = initRepo();
  try {
    const sha = commit(dir, 'src/components/Baz.tsx', '<div/>', 'feat: baz');
    recordApproval(dir, { branch: 'feat/baz', commitSha: sha, contentHash: 'hash1' });
    const r = queryPushAllowed(dir);
    assert.equal(r.allowed, true);
  } finally { cleanup(); }
});

test('push-allowed: stale ledger entry (older than TTL) → blocked', () => {
  const { dir, cleanup } = initRepo();
  try {
    const sha = commit(dir, 'src/components/Old.tsx', '<div/>', 'feat: old');
    // Write a stale entry directly.
    const ledger = join(dir, '.claude/visual-qa/approvals.jsonl');
    mkdirSync(join(dir, '.claude/visual-qa'), { recursive: true });
    const stale = new Date(Date.now() - 30 * 86400_000).toISOString();
    writeFileSync(ledger, JSON.stringify({
      ts: stale, sessionId: 's', branch: 'b', commitSha: sha, contentHash: 'x',
    }) + '\n');
    process.env.VISUAL_QA_LEDGER_TTL_DAYS = '7';
    const r = queryPushAllowed(dir);
    assert.equal(r.allowed, false);
    delete process.env.VISUAL_QA_LEDGER_TTL_DAYS;
  } finally { cleanup(); }
});

test('push-allowed: mix of UI and non-UI commits — only UI need entries', () => {
  const { dir, cleanup } = initRepo();
  try {
    commit(dir, 'docs/x.md', 'a\n', 'docs');
    const uiSha = commit(dir, 'src/components/M.tsx', 'a\n', 'feat ui');
    commit(dir, 'docs/y.md', 'b\n', 'docs');
    recordApproval(dir, { branch: 'feat', commitSha: uiSha, contentHash: 'h' });
    const r = queryPushAllowed(dir);
    assert.equal(r.allowed, true);
  } finally { cleanup(); }
});
