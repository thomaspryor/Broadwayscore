/**
 * verify-seo-health-clean.test.mjs — the RECHECK-AFTER acceptance command for
 * card #419's remaining criterion: "the condition health-check:SEO: health does
 * not fire on the next scheduled check".
 *
 * Like scripts/verify-provider-spend-streak.test.mjs, this deliberately asserts
 * against LIVE repo data (data/audit/seo-health.json) rather than a fixture. Its
 * whole purpose is to be re-run by scripts/autonomous-acceptance-recheck.js
 * after the next weekly SEO cron (check-seo-health.yml, Sundays 08:00 UTC) has
 * written a fresh snapshot. A red run here is not a code regression — it is the
 * claim being disproven, which is exactly the signal the RECHECK-AFTER stamp
 * exists to produce.
 *
 * Why this is the right assertion: health-check.js:1407 fires the "SEO: health"
 * digest condition whenever data.anomalies is non-empty (error => status error,
 * anything else => status warn). So "does not fire" is precisely "anomalies is
 * empty in the snapshot the digest reads".
 *
 * Deliberately NOT registered in tests/unit-test-manifest.txt — it must not
 * redden the normal test suite, because it is asserting a live-world outcome
 * that is legitimately false until the next cron run confirms it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, '..', 'data', 'audit', 'seo-health.json');

// The snapshot must have been refreshed AFTER the show-page RSC payload fix
// (#419) went live on production on 2026-08-03. An older snapshot describes a
// world that no longer exists and must not be read as a pass.
const FIX_LIVE_ON = '2026-08-03';

test('seo-health.json is fresh and reports no anomalies (card #419)', () => {
  assert.ok(
    fs.existsSync(SNAPSHOT),
    `${SNAPSHOT} missing — check-seo-health.yml has not written a snapshot`,
  );

  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const checked = (data.lastChecked || data.timestamp || '').slice(0, 10);

  assert.ok(
    checked > FIX_LIVE_ON,
    `seo-health.json lastChecked=${checked || '(none)'} is not newer than ${FIX_LIVE_ON}, `
      + 'so it predates the #419 payload fix going live. Wait for the next '
      + 'check-seo-health.yml run (Sundays 08:00 UTC) before treating this as a pass.',
  );

  const anomalies = Array.isArray(data.anomalies) ? data.anomalies : [];
  assert.deepEqual(
    anomalies.map(a => a.message || a.type || 'unknown'),
    [],
    'health-check.js fires the "SEO: health" digest condition on any non-empty '
      + 'anomalies array (scripts/health-check.js:1407). Anomalies above are what '
      + 'is still firing.',
  );
});
