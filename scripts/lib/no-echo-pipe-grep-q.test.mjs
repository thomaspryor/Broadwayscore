// BRO-4297: `echo "$var" | grep -q ...` under `set -o pipefail` gets EPIPE once
// $var exceeds the 64 KiB pipe buffer and grep exits at the first match, so the
// pipeline reports the opposite of the match. Use `grep -q PAT <<<"$var"`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const BAD = /\b(?:echo|printf)\b[^|\n]*\|\s*grep\s+-[a-zA-Z]*q/;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.sh')) out.push(p);
  }
  return out;
}

test('detector flags the echo|grep -q shape and accepts here-strings', () => {
  assert.ok(BAD.test('if echo "$OUT" | grep -qiE "x"; then'));
  assert.ok(BAD.test('printf "%s" "$v" | grep -q x'));
  assert.ok(!BAD.test('if grep -qiE "x" <<<"$OUT"; then'));
});

test('no shell script pipes echo/printf into grep -q', () => {
  const hits = [];
  for (const f of walk(path.join(ROOT, 'scripts'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (!/^\s*#/.test(l) && BAD.test(l)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'use grep -q PATTERN <<<"$var"');
});

// BRO-6906: the same EPIPE hazard lives in workflow run: blocks (echo "$OUT" |
// grep -q ...). Workflows run under bash with pipefail, so use here-strings.
// Only the echo form is gated: printf '%s' "$SHOW" | grep -Eq validations check
// short workflow inputs, not captured command output.
test('no workflow pipes echo into grep -q', () => {
  const BAD_ECHO = /\becho\b[^|\n]*\|\s*grep\s+-[a-zA-Z]*q/;
  const dir = path.join(ROOT, '.github', 'workflows');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => {
      if (!/^\s*#/.test(l) && BAD_ECHO.test(l)) hits.push(`.github/workflows/${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'use grep -q PATTERN <<<"$var"');
});
