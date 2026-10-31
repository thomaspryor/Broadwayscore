// BRO-6199: call-site test for redactEmails. scripts/lib/welcome-email.test.mjs
// proves the function; this spawns the real send-welcome-emails.js (--test-send,
// fetch stubbed by a preload so nothing reaches Resend) and checks that the
// recipient address echoed back in the API reply is scrubbed from the log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('send-welcome-emails.js redacts email addresses in the Resend reply it logs (redactEmails call site)', () => {
  const res = spawnSync('node', [
    '--require', path.join(repoRoot, 'scripts/test-fixtures/stub-fetch-resend.cjs'),
    path.join(repoRoot, 'scripts/send-welcome-emails.js'), '--test-send',
  ], {
    cwd: repoRoot,
    env: { ...process.env, RESEND_API_KEY: 'test-key' },
    encoding: 'utf8',
    timeout: 60000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `send-welcome-emails.js failed:\n${out}`);
  assert.match(res.stdout, /Test send to .*HTTP 200 -> sent/);
  assert.ok(!out.includes('leak.check@example.com'), 'recipient address from the API reply was logged unredacted');
});
