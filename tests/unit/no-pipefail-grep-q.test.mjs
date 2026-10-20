/**
 * Under `set -o pipefail`, `git … | grep -q X` is flaky: grep exits on the first
 * match, git can then take SIGPIPE, and the pipeline's status reads as "not found"
 * (BRO-5777: scripts/lib/sync-audit-checkout.test.sh case 8 refused two lands,
 * and passed on retry for others). Capture first: grep -q X <<<"$(git …)".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no shell test pipes git into grep -q under pipefail', () => {
  const dir = path.join(ROOT, 'scripts/lib');
  const offenders = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.sh'))) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    if (!/set -\w*o pipefail|set -o pipefail/.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (/\bgit\b[^|#]*\|\s*grep\s+-[a-zA-Z]*q/.test(line)) offenders.push(`scripts/lib/${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `capture git output first (grep -q X <<<"$(git ...)"):\n${offenders.join('\n')}`);
});
