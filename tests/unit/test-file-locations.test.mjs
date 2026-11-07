// Every tracked test file must live in a directory something actually runs or
// audits. scripts/lib/unit-test-collection.js (BRO-2483) and
// scripts/audit-orphan-tests.js both scan a FIXED set of directories, each
// non-recursively, so a test written into a new folder (say
// scripts/foo/bar.test.mjs) ran nowhere and no audit noticed. Found by the
// BRO-2483 ship-check. Adding a test directory means wiring a runner for it,
// then listing it here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const collection = require(join(ROOT, 'scripts/lib/unit-test-collection.js'));
const { SCANNED_DIRS } = require(join(ROOT, 'scripts/audit-orphan-tests.js'));

// Directories outside the collector and the orphan audit, each with what runs it.
const EXTRA_DIRS = new Map([
  ['scripts/lib', "test.yml's tests=(scripts/lib/*.test.mjs) step and land's scripts-lib-tests gate"],
  ['tests/acceptance', 'card acceptance probes, run by their Linear card VERIFY line (e.g. BRO-5222)'],
  ['tests/sql', 'SQL fixtures run by scripts/lib/*-roundtrip.mjs against Supabase'],
]);

const TEST_FILE_RE = /\.test\.(mjs|js|cjs|ts|tsx|sh|sql)$/;

function knownDirs() {
  const dirs = new Set([...collection.NODE_TEST_DIRS, ...SCANNED_DIRS, ...EXTRA_DIRS.keys()]);
  // Every directory a tsx/e2e manifest entry lives in is run by that manifest.
  for (const rel of collection.OTHER_RUNNER_MANIFESTS) {
    for (const line of readFileSync(join(ROOT, rel), 'utf8').split('\n')) {
      const p = line.trim();
      if (p && !p.startsWith('#')) dirs.add(posix.dirname(p));
    }
  }
  return dirs;
}

test('every tracked test file sits in a directory that is collected, scanned or run', () => {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter((f) => TEST_FILE_RE.test(f) && !f.startsWith('node_modules/'));
  assert.ok(tracked.length > 1000, `expected >1000 tracked test files, got ${tracked.length}`);
  const dirs = knownDirs();
  const stray = tracked.filter((f) => !dirs.has(posix.dirname(f)));
  assert.deepEqual(
    stray, [],
    'these test files are in a directory nothing runs or audits (the collector and the orphan audit ' +
      'scan fixed directories, non-recursively). Move each into tests/unit/ (or another collected dir), ' +
      'or wire a runner for the new directory and add it to EXTRA_DIRS with what runs it:\n  ' + stray.join('\n  '),
  );
});

test('every EXTRA_DIRS entry still holds tracked test files (no stale entries)', () => {
  for (const dir of EXTRA_DIRS.keys()) {
    const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--', `${dir}/`], { encoding: 'utf8' })
      .split('\n').filter((f) => TEST_FILE_RE.test(f) && posix.dirname(f) === dir);
    assert.ok(files.length > 0, `EXTRA_DIRS lists ${dir} but it holds no tracked test file; drop the entry`);
  }
});
