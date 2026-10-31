import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('production dependencies have no critical or high npm advisories', { timeout: 150_000 }, (t) => {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json', '--fetch-retries=0', '--fetch-timeout=30000'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  const report = JSON.parse(result.stdout);
  const networkErrors = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ERR_SOCKET_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'E502', 'E503', 'E504',
  ]);
  // npm 10 can leave error.code empty and put the connection failure in message.
  const networkCode = [...networkErrors].find(code =>
    new RegExp(`\\b${code}\\b`).test(`${report.error?.code || ''} ${report.message || ''} ${result.stderr}`)
  );
  if (report.error && networkCode) {
    t.skip(`npm registry unreachable (${networkCode}); dependency audit could not run`);
    return;
  }
  assert.equal(report.error, undefined, `npm audit failed: ${JSON.stringify(report.error)}`);
  assert.ok(result.status === 0 || result.status === 1, `npm audit exited ${result.status}`);
  const counts = report.metadata?.vulnerabilities;
  assert.ok(counts, 'npm audit did not return vulnerability metadata');
  t.diagnostic(`npm audit --omit=dev: ${counts.critical} critical, ${counts.high} high`);
  assert.equal(counts.critical, 0, 'production dependencies have critical advisories');
  assert.equal(counts.high, 0, 'production dependencies have high advisories');
});
