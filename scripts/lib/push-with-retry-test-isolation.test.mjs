// BRO-2664: push-with-retry.sh appends failure telemetry to the real
// data/audit/push-retry-failures.jsonl unless PUSH_FAILURE_LOG says otherwise,
// and in CI it logs on every failure path. Ten of its bash suites did exactly
// that on every CI run (found by test.yml's ledger isolation check). Every
// push-with-retry*.test.sh must give PUSH_FAILURE_LOG a file-scope default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RE = /^export PUSH_FAILURE_LOG="\$\{PUSH_FAILURE_LOG:-[^}]+\}"$/m;

test('every push-with-retry bash suite defaults PUSH_FAILURE_LOG away from data/audit', () => {
  const suites = fs.readdirSync(LIB).filter((f) => /^push-with-retry.*\.test\.sh$/.test(f));
  assert.ok(suites.length >= 10, `expected the push-with-retry bash suites, found ${suites.length}`);
  const missing = suites.filter((f) => {
    const m = fs.readFileSync(path.join(LIB, f), 'utf8').match(DEFAULT_RE);
    return !m || /data\/audit/.test(m[0]);
  });
  assert.deepEqual(missing, [], `add: export PUSH_FAILURE_LOG="\${PUSH_FAILURE_LOG:-/dev/null}" near the top of ${missing.join(', ')}`);
});

// BRO-6592: push-with-retry.sh runs ensure_disk_floor first, which on a host
// under 5GB free runs the real worktree GC (~220s on the Mac Studio, outside
// the deadline clock). The early-fallback-budget hang case asserts <60s and
// failed at 240s. Every bash suite must turn the preflight off at file scope.
test('every push-with-retry bash suite disables the host disk preflight', () => {
  const suites = fs.readdirSync(LIB).filter((f) => /^push-with-retry.*\.test\.sh$/.test(f));
  const missing = suites.filter((f) => !/^export DISK_PREFLIGHT_FLOOR_GB=0$/m.test(fs.readFileSync(path.join(LIB, f), 'utf8')));
  assert.deepEqual(missing, [], `add: export DISK_PREFLIGHT_FLOOR_GB=0 near the top of ${missing.join(', ')}`);
});
