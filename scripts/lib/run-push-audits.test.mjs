import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'run-push-audits.sh');

// --list mode selects without running (card #835) — fast + deterministic,
// doesn't pay for real audit runs against live repo state.
function listAudits(files) {
  const out = execFileSync('bash', [SCRIPT, '--list'], {
    input: files.join('\n'),
    encoding: 'utf8',
  });
  return out.trim().split('\n').filter(Boolean).sort();
}

test('empty file list selects no audits', () => {
  assert.deepEqual(listAudits([]), []);
});

test('unrelated file selects no audits', () => {
  assert.deepEqual(listAudits(['README.md']), []);
});

test('tests/unit/*.test.mjs selects tests-vs-derived-data + orphan-tests', () => {
  assert.deepEqual(
    listAudits(['tests/unit/push-ledger-store.test.mjs']),
    ['orphan-tests', 'tests-vs-derived-data']
  );
});

test('scripts/*.js selects unbounded-fetch + write-routing + help-flag-safety', () => {
  assert.deepEqual(
    listAudits(['scripts/recover-wsj-browser.js']),
    ['help-flag-safety', 'unbounded-fetch', 'write-routing']
  );
});

// The help-flag audit is the most frequent recurring cause of a red main here, so
// its selection is asserted on its own input too, not only via the scripts/*.js
// case above: the baseline file can change without any script changing.
test('help-flag baseline change alone selects help-flag-safety', () => {
  assert.deepEqual(
    listAudits(['scripts/.help-flag-safety-baseline.json']),
    ['help-flag-safety']
  );
});

test('tests/e2e/*.ts selects playwright-evaluate-click only', () => {
  assert.deepEqual(listAudits(['tests/e2e/foo.spec.ts']), ['playwright-evaluate-click']);
});

test('.github/workflows/*.yml selects unbounded-fetch', () => {
  assert.deepEqual(listAudits(['.github/workflows/test.yml']), [
    'orphan-tests',
    'tests-vs-derived-data',
    'unbounded-fetch',
  ]);
});

test('argv form (no stdin) matches piped-stdin form', () => {
  const out = execFileSync(
    'bash',
    [SCRIPT, '--list', 'scripts/recover-wsj-browser.js'],
    { encoding: 'utf8' }
  );
  assert.deepEqual(out.trim().split('\n').filter(Boolean).sort(), [
    'help-flag-safety',
    'unbounded-fetch',
    'write-routing',
  ]);
});

test('mixed file list unions all applicable audits', () => {
  assert.deepEqual(
    listAudits(['scripts/foo.js', 'tests/unit/bar.test.mjs', 'tests/e2e/baz.spec.ts']),
    ['help-flag-safety', 'orphan-tests', 'playwright-evaluate-click', 'tests-vs-derived-data', 'unbounded-fetch', 'write-routing']
  );
});
