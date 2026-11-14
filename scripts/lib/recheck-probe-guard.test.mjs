import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { recheckProbeGuardViolations } = require('./recheck-probe-guard.js');

test('broad probe wording blocks, and a CHECKABLE_FROM declaration alone is not a skip guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-guards-'));
  const cases = [
    ['narrow', 'RECHECK-AFTER probe', "test('x', () => {});", true],
    ['date', 'RECHECK-AFTER 2026-08-16', "test('x', () => {});", true],
    ['hyphen', 'acceptance-probe', "test('x', () => {});", true],
    ['space', 'acceptance probe', "test('x', () => {});", true],
    ['unused', 'RECHECK-AFTER probe', "const CHECKABLE_FROM = Date.parse('2026-08-16');\ntest('x', () => {});", true],
    ['disabled', 'RECHECK-AFTER probe', "test('x', { skip: false }, () => {});", true],
    ['option', 'acceptance probe', "const CHECKABLE_FROM = Date.parse('2026-08-16');\ntest('x', { skip: Date.now() < CHECKABLE_FROM && 'not yet' }, () => {});", false],
    ['context', 'RECHECK-AFTER probe', "test('x', t => { if (Date.now() < CHECKABLE_FROM) { t.skip('not yet'); return; } });", false],
    ['green', 'RECHECK-AFTER probe', '// RECHECK-GREEN-TODAY: passed against live data on 2026-10-24', false],
    ['shim', 'acceptance-command shim', "test('x', () => {});", false],
  ];
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const [name, , body] of cases) fs.writeFileSync(path.join(root, `scripts/${name}.test.mjs`), body);
    const source = 'const EXEMPT_NEVER_CI = {\n' + cases.map(([name, comment]) =>
      `  // ${comment}\n  'scripts/${name}.test.mjs': 'BRO-6077',`).join('\n') + '\n};';
    assert.deepEqual(recheckProbeGuardViolations({ root, source }),
      cases.filter(([, , , violation]) => violation).map(([name]) => `scripts/${name}.test.mjs`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the six deferred probes actually skip before their dates without reading data or calling GitHub', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const probes = [
    'scripts/verify-provider-spend-streak.test.mjs',
    'scripts/verify-seo-health-clean.test.mjs',
    'scripts/verify-main-green-streak.test.mjs',
    'scripts/verify-dispatch-dead-rate-recovery.test.mjs',
    'scripts/verify-update-show-status-no-cancellations.test.mjs',
    'scripts/tests/verify-watchdog-claim-loop-gone.test.mjs',
  ];
  // Only the child clock changes. Execute the real probes, including imports.
  const earlyClock = 'data:text/javascript,' + encodeURIComponent("Date.now = () => Date.parse('2026-08-01T00:00:00Z');");
  for (const probe of probes) {
    await t.test(probe, () => {
      // --test-reporter=tap: newer Node defaults to the spec reporter ("ℹ skipped 1"),
      // which the TAP assertions below never matched (BRO-6506 land floor).
      const output = execFileSync(process.execPath, ['--import', earlyClock, '--test', '--test-reporter=tap', path.join(root, probe)], {
        encoding: 'utf8', timeout: 30_000,
        // node:test otherwise treats this child as part of its parent's TAP.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
      });
      assert.match(output, /# skipped 1\b/);
      assert.match(output, /# fail 0\b/);
    });
  }
});
