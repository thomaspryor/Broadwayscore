// BRO-3917: linear-drain-parked must (a) select technically-parked session
// cards as well as auto-filed trackers, and (b) never abort before selecting
// because its checkout-sync gate refused a dirty append-only ledger.
// (b) lives in the shared gate, scripts/lib/sync-audit-checkout.sh, which
// linear-drain-parked.js runs first; its real-git tests are asserted here by
// running that suite, so this file fails if the guard regresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = require(path.join(HERE, 'linear-drain-parked.js'));

const VERIFY = '\n\nVERIFY: `node --test scripts/lib/linear-drain-parked.test.mjs`\n';
const issue = (n, description, extra = {}) => ({
  identifier: `BRO-${n}`, title: `t${n}`, priority: 2, state: { type: 'backlog' }, description, ...extra,
});

test('auto-filed parked tracker with a safe VERIFY is selected', () => {
  const sel = lib.selectDrainCandidates([issue(1, lib.AUTO_FILED_MARKER + VERIFY)]);
  assert.deepEqual(sel.map((i) => i.identifier), ['BRO-1']);
});

test('a card without a safe VERIFY is never selected', () => {
  assert.deepEqual(lib.selectDrainCandidates([issue(2, lib.AUTO_FILED_MARKER)]), []);
});

test('already-attempted and over-limit candidates are skipped, lowest number first', () => {
  const issues = [3, 4, 5].map((n) => issue(n, lib.AUTO_FILED_MARKER + VERIFY));
  const sel = lib.selectDrainCandidates(issues, { limit: 1, alreadyAttempted: new Set(['BRO-3']) });
  assert.deepEqual(sel.map((i) => i.identifier), ['BRO-4']);
});

test('a started (non-parked-state) issue is not selected', () => {
  const started = issue(6, lib.AUTO_FILED_MARKER + VERIFY, { state: { type: 'started' } });
  assert.deepEqual(lib.selectDrainCandidates([started]), []);
});

test('the sync gate drain-parked runs first survives a dirty ledger with duplicate rows (abort-before-selecting regression)', () => {
  const suite = path.join(HERE, 'sync-audit-checkout.test.mjs');
  assert.ok(fs.existsSync(suite));
  const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=BRO-3917', suite], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.match(out, /# pass [1-9]/);
  assert.match(out, /# fail 0/);
});
