// BRO-7541 class guard: a failed backup run must escalate to a tracked card, not just the digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { backupFailureEscalations, BACKUP_CRON_NAMES, BACKUP_FAILED_PREFIX, recoveredFailureKeys } = require('../../scripts/lib/cron-health-warnings.js');
const wf = fs.readFileSync(new URL('../../.github/workflows/check-cron-health.yml', import.meta.url), 'utf8');

test('a failed backup warning becomes an escalation; other crons do not', () => {
  const w = '⚠️ R2 Cold Backup: Latest run failed (last success 173h ago)\n⚠️ Fetch All Image Formats: Latest run failed (last success 3h ago)';
  const out = backupFailureEscalations(w);
  assert.deepEqual(out.map((c) => c.conditionKey), [`${BACKUP_FAILED_PREFIX}R2 Cold Backup`]);
});

test('every backup workflow in CRITICAL_CRONS is in BACKUP_CRON_NAMES', () => {
  const entries = [...wf.matchAll(/"([\w.-]*backup[\w.-]*\.yml)\|\d+\|([^"]+)"/gi)];
  assert.ok(entries.length >= 3, 'found backup entries');
  for (const [, file, name] of entries) assert.ok(BACKUP_CRON_NAMES.includes(name), `${file} (${name}) missing from BACKUP_CRON_NAMES`);
});

test('check-cron-health.yml wires the escalation step, advisory, severity error + auto', () => {
  const i = wf.indexOf('Escalate failed backups to a tracked card');
  assert.ok(i > 0, 'step exists');
  const block = wf.slice(i, i + 2500);
  assert.match(block, /continue-on-error: true/);
  assert.match(block, /backupFailureEscalations/);
  assert.match(block, /severity: "error"/);
  assert.match(block, /disposition: "auto"/);
});

test('recovery resolves backup keys, and still-failing ones are not treated as recovered', () => {
  const ledger = { [`${BACKUP_FAILED_PREFIX}R2 Cold Backup`]: { status: 'open' } };
  assert.deepEqual(recoveredFailureKeys(ledger, []), [`${BACKUP_FAILED_PREFIX}R2 Cold Backup`]);
  assert.deepEqual(recoveredFailureKeys(ledger, [`${BACKUP_FAILED_PREFIX}R2 Cold Backup`]), []);
});

test('stale-backup marker escalates the card but is NOT routed by the digest as "not yet stale"', () => {
  const { parseCronWarnings } = require('../../scripts/lib/cron-health-warnings.js');
  const w = '⚠️ R2 Cold Backup: Stale backup, latest run cancelled (last success 200h ago)';
  assert.deepEqual(backupFailureEscalations(w).map((c) => c.name), ['R2 Cold Backup']);
  assert.equal(parseCronWarnings(w).length, 0);
  assert.match(wf, /\^\(failure\|cancelled\|timed_out\)\$/);
});
