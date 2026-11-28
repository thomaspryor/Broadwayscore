/**
 * LIVE acceptance test — the VERIFY line on the parked "exemption expires
 * soon" cards filed by scripts/audit-dependencies.js --alert --warn-days=14
 * (BRO-4434). Passes when no allowlist entry expires within the next 14 days
 * (extended, or removed after an upgrade). Lives in tests/live/ and in NO unit
 * manifest: it needs the npm registry and its answer changes with the calendar.
 *
 *   node --test tests/live/audit-dependencies-no-expiring.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateAuditReport, ALLOWLIST } = require('../../scripts/audit-dependencies');

const WARN_DAYS = 14; // must match audit-dependencies.yml's --warn-days

function liveReport() {
  let raw;
  try {
    raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    raw = e.stdout;
  }
  assert.ok(raw, 'npm audit produced no output');
  return JSON.parse(raw);
}

test(`live: no allowlist entry expires within ${WARN_DAYS} days`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = evaluateAuditReport(liveReport(), ALLOWLIST, today, { warnDays: WARN_DAYS });
  assert.equal(r.couldNotRun, false, `audit could not run: ${r.errors.join('; ')}`);
  assert.deepEqual(
    r.expiringSoon, [],
    `expiring soon:\n  ${r.expiringSoon.map((e) => `${e.ghsa} (${e.module}) expires ${e.expires}, ${e.daysLeft} day(s) left`).join('\n  ')}`,
  );
});
