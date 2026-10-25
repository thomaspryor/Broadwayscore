// BRO-4219: runs the partial-clone bash integration suite for push-with-retry.sh
// from inside the `scripts/lib/*.test.mjs` glob that test.yml's unit-tests job
// and land.yml's gauntlet already execute.
//
// Why a node wrapper instead of a `run: bash …` step next to the other
// push-with-retry.*.test.sh steps: registering a bash test needs a test.yml
// edit, and the landing PAT lost the `workflow` scope on 2026-09-29 (BRO-4143),
// so no workflow-file change can land through land.yml right now. The bash
// script therefore carries a non-`.test.sh` name (the colocated-test CI-coverage
// guard, scripts/lib/colocated-test-ci-coverage.test.mjs, only accepts a
// literal run: line for `*.test.sh`) and THIS file is what CI runs. When
// BRO-4143 is resolved, a `run: bash` step can be added and this wrapper kept
// or dropped; either way the suite stays executed.
//
// What the suite proves (see the script's header): three consecutive pushes
// from a REAL blobless clone under churn land with one root and both sides
// intact; the verbatim Land promisor stderr makes the script retry the rebase
// rather than fall to `merge -X ours`; a genuine conflict, a plain clone and
// PUSH_SKIP_PROMISOR_RETRY=1 never trigger the retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'push-with-retry.partial-clone.integration.sh');

test('push-with-retry.sh on a blobless partial clone: churn, promisor retry, over-fire guards, kill switch', () => {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const summary = out.split('\n').filter((l) => /^(PASS|FAIL)\[|^===/.test(l)).join('\n');
  assert.equal(r.status, 0, `bash suite exited ${r.status} (signal ${r.signal || 'none'}):\n${summary}\n--- tail ---\n${out.slice(-4000)}`);
  for (const n of [1, 2, 3, 4, 5]) {
    assert.match(out, new RegExp(`^PASS\\[${n}\\]`, 'm'), `case ${n} did not report PASS:\n${summary}`);
  }
  assert.doesNotMatch(out, /^FAIL\[/m, `a case reported FAIL:\n${summary}`);
});
