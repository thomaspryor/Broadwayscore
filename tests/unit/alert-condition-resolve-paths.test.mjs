import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// BRO-2458: scripts that file disposition:'auto' alert cards must resolve the
// condition when it clears, or the card outlives it. These cover the resolve
// paths added for check-push-ledger.js and health-check.js against a temp
// ledger (set before the router loads, so no real ledger is touched).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-resolve-'));
const ledgerPath = path.join(tmp, 'alert-ledger.json');
process.env.ALERT_LEDGER_PATH = ledgerPath;
process.env.ALERT_DIGEST_QUEUE_PATH = path.join(tmp, 'digest.json');
process.env.ALERT_ATTEMPTS_LOG_PATH = path.join(tmp, 'attempts.jsonl');

const require = createRequire(import.meta.url);
const router = require('../../scripts/lib/owner-alert-router.js');
const { revertConditionKey, resolveRevertAlert } = require('../../scripts/check-push-ledger.js');
const { clearedHealthCheckKeys } = require('../../scripts/lib/health-row-check-cmd.js');

const HOUR = 3600 * 1000;
function seed(conditions) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ conditions }, null, 2));
}
const open = (lastSeenHoursAgo) => ({ status: 'open', firstSeen: new Date(Date.now() - 200 * HOUR).toISOString(), lastSeen: new Date(Date.now() - lastSeenHoursAgo * HOUR).toISOString(), notifyCount: 1, linearIdentifier: 'BRO-1' });

test('check-push-ledger: a recovered commit resolves exactly its own revert condition', () => {
  const entry = { branch: 'main', sha: 'abcdef1234567890' };
  const key = revertConditionKey(entry);
  assert.equal(key, 'push-ledger-revert:main:abcdef123456');
  seed({ [key]: open(1), 'push-ledger-revert:main:000000000000': open(1) });
  resolveRevertAlert(entry);
  const c = router.loadLedger().conditions;
  assert.equal(c[key].status, 'resolved');
  assert.equal(c[key].resolveReason, 'commit reachable again');
  assert.equal(c['push-ledger-revert:main:000000000000'].status, 'open', 'other entries untouched');
  // Nothing filed for this entry: a no-op, no throw.
  resolveRevertAlert({ branch: 'main', sha: 'ffffffffffffffff' });
});

test('health-check: only ran-and-passed rows count as cleared', () => {
  const keys = clearedHealthCheckKeys([
    { name: 'Freshness: shows.json', status: 'pass', message: '2h old' },
    { name: 'Freshness: grosses.json', status: 'ok', message: 'Skipped (off-season)' },
    { name: 'Sync: review-texts vs reviews.json', status: 'pass', message: 'Skipped — review-texts not checked out' },
    { name: 'Data quality: x', status: 'warn', message: 'bad' },
    { name: 'Data quality: y', status: 'error', message: 'worse' },
  ]);
  assert.deepEqual(keys, ['health-check:Freshness: shows.json']);
});

test('health-check: a name that also failed in the same run is not cleared', () => {
  const keys = clearedHealthCheckKeys([
    { name: 'Dup', status: 'pass', message: 'fine' },
    { name: 'Dup', status: 'error', message: 'broken' },
    { name: 'Twice', status: 'pass', message: 'a' },
    { name: 'Twice', status: 'pass', message: 'b' },
  ]);
  assert.deepEqual(keys, ['health-check:Twice']);
});

test('health-check: a passing row resolves only after the incident gap (flapping rows keep their card)', () => {
  seed({
    'health-check:Quiet row': open(router.INCIDENT_GAP_RESET_HOURS + 5),
    'health-check:Flappy row': open(24),
  });
  const keys = clearedHealthCheckKeys([
    { name: 'Quiet row', status: 'pass', message: 'fine' },
    { name: 'Flappy row', status: 'pass', message: 'fine' },
  ]);
  assert.deepEqual(router.resolveQuietConditions(keys, { reason: 'health-check row passing' }), ['health-check:Quiet row']);
  assert.equal(router.loadLedger().conditions['health-check:Flappy row'].status, 'open');
});
