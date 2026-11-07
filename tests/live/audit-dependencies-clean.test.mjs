/**
 * LIVE acceptance test — the VERIFY line on cards filed by
 * scripts/audit-dependencies.js --alert (BRO-4434).
 *
 * Runs the REAL `npm audit --json` against the current lockfile and passes
 * only when the allowlist gate is clean: no unallowlisted critical advisory,
 * no expired or disqualified allowlist entry. It is deliberately in
 * tests/live/ and in NO unit manifest: it needs the npm registry and its
 * answer changes with the advisory feed, not with the code.
 *
 *   node --test tests/live/audit-dependencies-clean.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateAuditReport, ALLOWLIST } = require('../../scripts/audit-dependencies');

function liveReport() {
  let raw;
  try {
    raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    raw = e.stdout; // non-zero exit = vulnerabilities exist; the JSON is still on stdout
  }
  assert.ok(raw, 'npm audit produced no output');
  return JSON.parse(raw);
}

test('live: no unallowlisted, expired or disqualified critical advisory', () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = evaluateAuditReport(liveReport(), ALLOWLIST, today);
  assert.equal(r.couldNotRun, false, `audit could not run: ${r.errors.join('; ')}`);
  assert.deepEqual(r.findings, [], `still open:\n  ${r.errors.join('\n  ')}`);
});
