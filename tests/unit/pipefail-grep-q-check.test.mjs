// `echo "$VAR" | grep -q` under pipefail reads as "no match" once $VAR is
// bigger than the pipe buffer (SIGPIPE -> 141). scripts/hooks/pre-push skipped
// its CLAUDE.md guards and workflow lints on large pushes because of it
// (2026-09-29, BRO-4328). require()s the real checker (CLAUDE.md §15) and runs
// it over the repo's shell scripts so the pattern cannot come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findPipefailGrepQ } = require('../../scripts/lib/pipefail-grep-q-check.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the bug is real: pipefail + echo | grep -q misses a match in large input', () => {
  const script = 'set -uo pipefail; big="CLAUDE.md\n$(seq 1 200000)"; if echo "$big" | grep -q "^CLAUDE.md$"; then echo match; else echo miss; fi; if grep -q "^CLAUDE.md$" <<<"$big"; then echo match; else echo miss; fi';
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['miss', 'match']);
});

test('flags echo/printf of a variable piped into grep -q only when pipefail is set', () => {
  const risky = 'set -euo pipefail\nif echo "$FILES" | grep -qE "^src/"; then :; fi\nprintf \'%s\\n\' "$X" | grep -qxF foo\n';
  assert.deepEqual(findPipefailGrepQ(risky).map(h => h.line), [2, 3]);
  assert.deepEqual(findPipefailGrepQ('if echo "$FILES" | grep -q x; then :; fi\n'), []);
  // Split flags, --quiet, an intermediate stage, and errexit-style set lines.
  const variants = 'set -o errexit -o pipefail\necho "$A" | grep -E -q x\necho "$A" | grep --quiet x\necho "$A" | tr " " "\\n" | grep -Fxq x\n';
  assert.deepEqual(findPipefailGrepQ(variants).map(h => h.line), [2, 3, 4]);
});

test('here-strings, comments and annotated lines are not flagged', () => {
  const src = 'set -o pipefail\nif grep -q x <<<"$FILES"; then :; fi\n# echo "$A" | grep -q b\necho "$A" | grep -q b # pipefail-grep-q-ok: tiny fixed input\n';
  assert.deepEqual(findPipefailGrepQ(src), []);
});

test('no shell script in the repo uses the pattern', () => {
  const r = spawnSync('node', ['scripts/lib/pipefail-grep-q-check.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
