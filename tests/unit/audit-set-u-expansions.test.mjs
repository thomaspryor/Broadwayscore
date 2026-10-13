import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const AUDIT = resolve('scripts/audit-set-u-expansions.sh');

function audit(body) {
  const dir = mkdtempSync(join(tmpdir(), 'setu-audit-'));
  try {
    writeFileSync(join(dir, 'x.sh'), body);
    return spawnSync('bash', [AUDIT, dir], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('flags a bare "${arr[@]}" in a set -u script', () => {
  const r = audit('#!/usr/bin/env bash\nset -euo pipefail\narr=()\nfor x in "${arr[@]}"; do :; done\n');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /x\.sh:4:/);
});

test('flags a bare ${arr[*]} in a string', () => {
  const r = audit('set -u\narr=()\necho "got: ${arr[*]}"\n');
  assert.equal(r.status, 1);
});

test('accepts the guarded idioms', () => {
  const r = audit('set -u\narr=()\nfor x in ${arr[@]+"${arr[@]}"}; do :; done\necho "${arr[*]:-}" "${#arr[@]}"\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('accepts a line marked set-u-safe, ignores comments and non-set-u scripts', () => {
  assert.equal(audit('set -u\narr=(a)\nfor x in "${arr[@]}"; do :; done # set-u-safe: literal non-empty\n').status, 0);
  assert.equal(audit('set -u\n# for x in "${arr[@]}"\n').status, 0);
  assert.equal(audit('set -e\narr=()\nfor x in "${arr[@]}"; do :; done\n').status, 0);
});

test('repo scripts are clean', () => {
  const r = spawnSync('bash', [AUDIT, 'scripts'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});
