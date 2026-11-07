import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'push-with-retry.sh');

/**
 * BRO-2974. push-with-retry.sh's local fetch+rebase+push loop slept its
 * escalating backoff after EVERY failed attempt, including the last one, so a
 * genuine exhaustion waited ~17-21s (at the default MAX_RETRIES=7) for an
 * attempt that never came before the failure path or the Git Data API
 * fallback began.
 *
 * Behavioural on purpose: runs the real script against a remote that cannot
 * exist, fallback disabled and a generous deadline so the loop exits by true
 * exhaustion (same setup as push-with-retry.deadline.test.sh case 5).
 */
function runExhaustion(maxRetries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwr-backoff-'));
  try {
    const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run(['init', '--quiet', '--initial-branch=main']);
    run(['config', 'user.email', 'test@example.invalid']);
    run(['config', 'user.name', 'Test']);
    run(['commit', '--quiet', '--allow-empty', '-m', 'init']);
    run(['remote', 'add', 'origin', 'file:///nonexistent/definitely/not/a/repo.git']);
    fs.writeFileSync(path.join(dir, 'state.json'), '{ "ok": 1 }\n');
    run(['add', 'state.json']);
    const res = spawnSync('bash', [SCRIPT, String(maxRetries), 'main'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PUSH_DEADLINE_SEC: '600',
        PUSH_API_FALLBACK_DISABLE: '1',
        PUSH_SKIP_FAILURE_LEDGER: '1',
        PUSH_FAILURE_LOG: path.join(dir, 'failures.jsonl'),
      },
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('BRO-2974: the final local attempt skips the backoff sleep', () => {
  const { code, out } = runExhaustion(2);
  assert.notEqual(code, 0, `exhaustion must fail the push; output:\n${out}`);
  assert.doesNotMatch(out, /overall deadline .* exceeded|breaking out of the local/,
    'an early exit fired; this case must exercise true exhaustion');
  const waits = out.match(/Waiting \d+s before retry/g) || [];
  assert.equal(waits.length, 1, `expected exactly one backoff (between attempts 1 and 2), got ${waits.length}:\n${out}`);
  assert.match(out, /No local attempts remain \(attempt 2 of 2\) — skipping backoff/);
});
