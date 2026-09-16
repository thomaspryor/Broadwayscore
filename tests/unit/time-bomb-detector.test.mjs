/**
 * Acceptance test for BRO-1987's time-bomb detector.
 *
 * scripts/audit-time-bomb-tests.js finds tests whose pass/fail outcome depends
 * on the wall clock by running the unit manifest twice — once at the real
 * clock, once with tests/helpers/clock-shift.mjs pushing Date.now() forward —
 * and diffing the failing sets. Running that CLI end-to-end here would mean
 * spawning all three manifests (1000+ files) twice inside a single unit test,
 * which would multiply test.yml's own runtime on every push — exactly the
 * cost this detector exists to avoid, and why the detector itself is not yet
 * wired into CI (see the script's own header). So this test exercises the
 * SAME mechanism (clock-shift.mjs + a real node --test child process) the CLI
 * uses, scoped to the one regression the card names, instead of shelling out
 * to the full audit.
 *
 * The regression: scripts/lib/seo-cwv-ack.js's /west-end LCP acknowledgment
 * expires 2026-08-18 by design. Before BRO-1987, the test asserting
 * "acknowledged → warning" called detectCWVAnomalies(cwv, []) with no
 * injected `today`, so it read the LIVE clock — passing until 2026-08-18,
 * then failing with no commit behind it. The fix (still in
 * tests/unit/seo-anomaly-detection.test.mjs) pins `today` to a fixed date
 * inside the window instead.
 *
 * BEFORE_EXPIRY/AFTER_EXPIRY straddle that fixed calendar boundary.
 * shiftDaysTo() recomputes, at run time, the clock-shift needed to land on
 * each one from whatever the REAL clock happens to be when this test
 * executes — so this test does not itself become a time bomb.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'tests', 'helpers', 'clock-shift.mjs');
const CHECK_SEO_HEALTH = path.join(REPO_ROOT, 'scripts', 'check-seo-health.js');

const BEFORE_EXPIRY = '2026-08-10';
const AFTER_EXPIRY = '2026-08-20';

function shiftDaysTo(isoDate) {
  return Math.round((Date.parse(`${isoDate}T12:00:00Z`) - Date.now()) / 86400000);
}

function runAtSimulatedDate(file, isoDate) {
  const env = { ...process.env, BSC_CLOCK_SHIFT_DAYS: String(shiftDaysTo(isoDate)), BSC_STAGE_LATENCY_MUTE: '1' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    ['--import', PRELOAD, '--test', '--test-reporter=tap', file],
    { cwd: REPO_ROOT, encoding: 'utf8', env }
  );
}

describe('time-bomb detector — seo-cwv-ack.js regression (BRO-1987)', () => {
  test('reproduction: the pre-fix pattern (no injected `today`) IS a time bomb', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timebomb-repro-'));
    const fixtureFile = path.join(fixtureDir, 'pre-fix-cwv-ack.test.mjs');
    // Mirrors the pre-fix call in tests/unit/seo-anomaly-detection.test.mjs:
    // detectCWVAnomalies(cwv, []) with NO third argument, so
    // findCWVFieldAcknowledgment falls back to `new Date()` — the live clock.
    fs.writeFileSync(
      fixtureFile,
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert';",
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        `const { detectCWVAnomalies } = require(${JSON.stringify(CHECK_SEO_HEALTH)});`,
        "test('west-end field-LCP regression is acknowledged', () => {",
        "  const cwv = [{ url: 'https://broadwayscorecard.com/west-end', performanceScore: 69, lcp: 2512, inp: null, cls: 0 }];",
        '  const issues = detectCWVAnomalies(cwv, []);',
        "  const lh = issues.find((i) => i.type === 'cwv_lighthouse_low');",
        "  assert.strictEqual(lh.severity, 'warning', 'acknowledged field regression should be a warning, not an error');",
        '});',
        '',
      ].join('\n')
    );

    try {
      const before = runAtSimulatedDate(fixtureFile, BEFORE_EXPIRY);
      const after = runAtSimulatedDate(fixtureFile, AFTER_EXPIRY);
      assert.strictEqual(
        before.status,
        0,
        `pre-fix pattern should pass while the ack is still active (${BEFORE_EXPIRY}):\n${before.stdout}`
      );
      assert.notStrictEqual(
        after.status,
        0,
        `pre-fix pattern should FAIL once the ack expires (${AFTER_EXPIRY}) — this is the time bomb ` +
          `the detector exists to catch, with no code change between the two runs:\n${after.stdout}`
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('fix: the real seo-anomaly-detection.test.mjs no longer depends on the wall clock here', () => {
    const realFile = path.join(REPO_ROOT, 'tests', 'unit', 'seo-anomaly-detection.test.mjs');
    const before = runAtSimulatedDate(realFile, BEFORE_EXPIRY);
    const after = runAtSimulatedDate(realFile, AFTER_EXPIRY);
    assert.strictEqual(
      before.status,
      0,
      `fixed test file should pass before the historical expiry (${BEFORE_EXPIRY}):\n${before.stdout}`
    );
    assert.strictEqual(
      after.status,
      0,
      `fixed test file should ALSO pass after the historical expiry (${AFTER_EXPIRY}) — the injected ` +
        `\`today\` makes this scenario clock-independent, so it never shows up in ` +
        'scripts/audit-time-bomb-tests.js\'s output:\n' +
        after.stdout
    );
  });
});
