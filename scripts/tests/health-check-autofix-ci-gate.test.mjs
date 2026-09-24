/**
 * health-check-autofix-ci-gate.test.mjs — BRO-467 regression guard.
 *
 * checkAutofixCanary()/checkAutofixThroughput() read Mac-local ledgers
 * (data/audit/autofix-canary-ledger.jsonl, backlog-drain-ledger.jsonl —
 * gitignored, never checked out in CI) plus digest-autofix-ledger.jsonl,
 * which is tracked but only reaches origin opportunistically (see
 * scripts/lib/sync-audit-checkout.sh's header) and can lag live Mac state by
 * an unbounded number of days. assessThroughputRow's zero-dispatch/zero-pass
 * streak logic assumes near-daily freshness, which a GitHub-hosted CI runner
 * can never supply — task #1221's own doctrine (never report 'pass' while a
 * source ledger is unreadable) then means this row can ONLY ever be
 * 'warn'/'error' from CI, regardless of true fleet health, generating a
 * permanently-recurring false "Autofix throughput DEAD" card (BRO-467) any
 * time nobody happens to merge-to-main for 2+ days. Both checks now skip
 * entirely when isCI is true — this pins that gate so it can't regress.
 *
 * checkDigestInvariantFail() is the same structural bug, confirmed live: its
 * ledger (data/audit/digest-invariant-fail-ledger.jsonl) is ALSO gitignored/
 * Mac-local, always reads null in CI, and always returns the identical
 * static 'warn' there — which had already filed and left open BRO-3370
 * ("BSC Daily: Digest: content-invariant check"), found via
 * `node scripts/linear-brain.js find "content-invariant"` while auditing for
 * siblings of BRO-467. Fixed the same way, same session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkAutofixCanary, checkAutofixThroughput, checkDigestInvariantFail } = require('../health-check.js');

test('BRO-467: checkAutofixCanary returns no rows in CI (structurally unmeasurable there)', () => {
  assert.deepEqual(checkAutofixCanary(true), []);
});

test('BRO-467: checkAutofixThroughput returns no rows in CI (structurally unmeasurable there)', () => {
  assert.deepEqual(checkAutofixThroughput(true), []);
});

test('BRO-467: checkAutofixCanary still evaluates outside CI (isCI=false unaffected)', () => {
  const rows = checkAutofixCanary(false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Autofix: daily canary (dispatch pipeline proof)');
  assert.ok(['pass', 'warn', 'error'].includes(rows[0].status));
});

test('BRO-467: checkAutofixThroughput still evaluates outside CI (isCI=false unaffected)', () => {
  const rows = checkAutofixThroughput(false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Autofix: throughput (dispatched/passed, daily)');
  assert.ok(['pass', 'warn', 'error'].includes(rows[0].status));
});

test('BRO-467: checkDigestInvariantFail returns no rows in CI (structurally unmeasurable there)', () => {
  assert.deepEqual(checkDigestInvariantFail(true), []);
});

test('BRO-467: checkDigestInvariantFail still evaluates outside CI (isCI=false unaffected)', () => {
  const rows = checkDigestInvariantFail(false);
  assert.equal(rows.length, 1);
  assert.ok(['pass', 'warn', 'error'].includes(rows[0].status));
});
