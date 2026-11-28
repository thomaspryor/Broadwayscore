// Class guard (2026-11-09): every land.yml run failed at "Install actionlint"
// with "gzip: stdin: not in gzip format": an unauthenticated `curl -sL ... | tar xz`
// of a GitHub release asset fed an error body straight into tar (no -f, no
// retry). Release downloads in workflows must go through
// scripts/lib/install-release-binary.sh (authenticated gh first, curl -f retry
// fallback, gzip -t check).
// Run: node --test scripts/lib/actionlint-install-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');

test('no workflow extracts a curl-downloaded GitHub release asset inline', () => {
  const bad = [];
  for (const f of fs.readdirSync(WF).filter((n) => /\.ya?ml$/.test(n))) {
    const lines = fs.readFileSync(path.join(WF, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/curl\b/.test(l) || !/releases\/download/.test(l)) return;
      const window = lines.slice(i, i + 4).join('\n');
      if (/\|\s*tar\b/.test(l) || /\btar\s+-?x/.test(window)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], 'use scripts/lib/install-release-binary.sh (authenticated, -f, retried, verified download)');
});

test('the install script authenticates first, fails on HTTP errors, retries, and verifies the archive', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'install-release-binary.sh'), 'utf8');
  assert.match(s, /set -euo pipefail/);
  assert.match(s, /gh release download/);
  assert.match(s, /curl -fsSL --retry/);
  assert.match(s, /gzip -t/);
  assert.match(s, /mktemp -d/);
});
