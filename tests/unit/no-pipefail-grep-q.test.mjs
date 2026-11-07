/**
 * Under `set -o pipefail`, `git … | grep -q X` is flaky: grep exits on the first
 * match, git can then take SIGPIPE, and the pipeline's status reads as "not found"
 * (BRO-5777: scripts/lib/sync-audit-checkout.test.sh case 8 refused two lands,
 * and passed on retry for others). Capture first: grep -q X <<<"$(git …)".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no shell test pipes git into grep -q under pipefail', () => {
  // Every tracked shell test, wherever it lives.
  const files = execFileSync('git', ['ls-files', '*.test.sh'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.length > 10, 'no shell tests found; update this guard');
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    if (!/set -\w*o pipefail|set -o pipefail/.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (/\bgit\b[^|#]*\|\s*grep\s+-[a-zA-Z]*q/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `capture git output first (grep -q X <<<"$(git ...)"):\n${offenders.join('\n')}`);
});
