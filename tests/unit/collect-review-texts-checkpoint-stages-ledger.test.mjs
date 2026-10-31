// Checkpoint commits must include data/audit/ (scraper-spend-ledger.jsonl):
// push-with-retry.sh's rebase-refusal / reset+cherry-pick paths wipe unstaged
// files, which dropped a whole run's provider rows on 2026-09-29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'collect-review-texts.js');

test('commitChanges stages the scraper-spend ledger with collection state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-checkpoint-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(path.join(dir, 'data/audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/collection-state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/audit/scraper-spend-ledger.jsonl'), '{"ts":"2026-09-29T00:00:00.000Z"}\n');
  fs.writeFileSync(path.join(dir, 'data/collection-state/state.json'), '{}\n');
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(SCRIPT)}).commitChanges(1)`], {
    cwd: dir, env: { ...process.env, GITHUB_ACTIONS: 'true' }, stdio: 'pipe',
  });
  const files = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n');
  assert.ok(files.includes('data/audit/scraper-spend-ledger.jsonl'), files.join(','));
  assert.ok(files.includes('data/collection-state/state.json'), files.join(','));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
