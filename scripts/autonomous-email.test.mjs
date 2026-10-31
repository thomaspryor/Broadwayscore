// BRO-6199: call-site test for sanitizePlainLanguageText. The unit test in
// scripts/lib proves the function; this spawns the real autonomous-email.js
// (--dry-run, all I/O stubbed by a preload) to prove the script actually runs
// the model's reply through the guard before it reaches the owner's email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('autonomous-email.js strips em dashes from the LLM plain-language copy (sanitizePlainLanguageText call site)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-email-'));
  const preview = path.join(dir, 'preview.html');
  const res = spawnSync('node', [
    '--require', path.join(repoRoot, 'scripts/test-fixtures/stub-autonomous-email-io.cjs'),
    path.join(repoRoot, 'scripts/autonomous-email.js'), '--dry-run',
  ], {
    cwd: repoRoot,
    env: { ...process.env, APPROVAL_HMAC_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test-key', STUB_PREVIEW_OUT: preview },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(res.status, 0, `autonomous-email.js failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /DRY RUN/);
  const html = fs.readFileSync(preview, 'utf8');
  assert.ok(html.includes('Fixes a broken page, safe to approve'), 'sanitized plain-language copy missing from the email');
  assert.ok(!html.includes('broken page \u2014 safe'), 'em dash from the model reply reached the email: guard not applied at the call site');
});
