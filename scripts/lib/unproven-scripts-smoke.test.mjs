// BRO-7802: smoke tests for scripts the landed-change audit found never run.
// Safe modes only: no email, no spend, no writes. Each spawns the real script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (script, args = [], env = {}) => spawnSync('node', [path.join('scripts', script), ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, LINEAR_API_KEY: '', RESEND_API_KEY: '', ...env },
});

test('file-feedback-card: no ISSUE_NUMBER is a no-op that exits 0', () => {
  const mod = require('../file-feedback-card.js');
  assert.equal(mod.main({}), 0);
  const r = run('file-feedback-card.js', [], { ISSUE_NUMBER: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to do/);
});

test('send-feedback-reply --dry-run: no diagnosis means nothing sent, exit 0', () => {
  const r = run('send-feedback-reply.js', ['--type=fixed', '--dry-run'], { ISSUE_BODY: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No DIAGNOSIS_JSON found/);
});

test('sweep-pending-commercial --dry-run prints a plan and writes nothing', () => {
  const r = run('sweep-pending-commercial.js', ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sweep plan/);
});

test('cleanup-stale-multishow-flags --dry-run reports counts', () => {
  const r = run('cleanup-stale-multishow-flags.js', ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /Total flagged: \d+/);
});

test('verify-existing-reviews loads and exposes its test seam without running main', () => {
  const m = require('../verify-existing-reviews.js');
  assert.equal(typeof m.main, 'function');
  assert.equal(typeof m._setVerifyForTest, 'function');
  assert.ok(m.VERIFY_PROMPT_VERSION);
});
