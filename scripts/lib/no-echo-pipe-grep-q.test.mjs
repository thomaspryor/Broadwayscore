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
