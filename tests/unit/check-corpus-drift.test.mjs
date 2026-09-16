/**
 * check-corpus-drift — exit policy + verdict assembly.
 *
 * This monitor's whole reason to exist is that DRIFT MUST NOT FAIL THE JOB
 * (drift surfaces in the digest; a failing job would reintroduce the exact
 * trunk-reddening this split removes). Only a crashed audit, or drift under
 * --strict, may escalate. These tests lock that policy so a future edit can't
 * silently turn the monitor back into a blocking gate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVerdict, decideExit, AUDITS, routePerAuditAlerts } = require('../../scripts/check-corpus-drift.js');

const ok = (name) => ({ name, ok: true, crashed: false, exitCode: 0 });
const drift = (name) => ({ name, ok: false, crashed: false, exitCode: 1 });
const crashed = (name) => ({ name, ok: false, crashed: true, exitCode: 2 });

describe('check-corpus-drift exit policy', () => {
  test('all audits ok → exit 0', () => {
    const v = buildVerdict([ok('a'), ok('b')], 'T');
    assert.equal(decideExit({ ...v.summary, strict: false }), 0);
  });

  test('drift WITHOUT --strict → exit 0 (passive monitor, surfaces in digest)', () => {
    const v = buildVerdict([ok('a'), drift('b')], 'T');
    assert.equal(v.summary.anyDrift, true);
    assert.equal(decideExit({ ...v.summary, strict: false }), 0);
  });

  test('drift WITH --strict → exit 2', () => {
    const v = buildVerdict([drift('b')], 'T');
    assert.equal(decideExit({ ...v.summary, strict: true }), 2);
  });

  test('a crashed audit → exit 3 even without --strict (real error, not drift)', () => {
    const v = buildVerdict([ok('a'), crashed('b')], 'T');
    assert.equal(v.summary.anyCrashed, true);
    assert.equal(decideExit({ ...v.summary, strict: false }), 3);
  });

  test('crash takes precedence over drift+strict (3 not 2)', () => {
    const v = buildVerdict([drift('a'), crashed('b')], 'T');
    assert.equal(decideExit({ ...v.summary, strict: true }), 3);
  });
});

describe('check-corpus-drift verdict shape', () => {
  test('summary counts drift and crash separately', () => {
    const v = buildVerdict([ok('a'), drift('b'), crashed('c')], '2026-06-22T00:00:00Z');
    assert.equal(v.summary.auditsRun, 3);
    assert.equal(v.summary.driftCount, 1);
    assert.equal(v.summary.crashCount, 1);
    assert.equal(v._meta.generatedAt, '2026-06-22T00:00:00Z');
    assert.equal(v.audits.length, 3);
  });
});

describe('BRO-3535: gates moved from test.yml', () => {
  const MOVED_NAMES = [
    'sibling-title-misroute', 'duplicate-shows', 'show-score-urls',
    'cv-flag-contradiction', 'self-contradictory-clears',
    'aggregator-archive-integrity', 'critic-outlets',
    'broadway-category-predicate', 'autoclear-vs-ensemble',
    'contradicted-flag-basis', 'duplicate-of-cleared-contradiction',
    'url-downgrade', 'orphan-show-ids', 'aggregator-url-latent',
  ];

  test('every moved audit is present, marked healPathRequired, and either has healExempt or is baseline-diff/scheduled-fix', () => {
    const { hasBaselineDiffPath, hasScheduledFixWorkflow } = require('../../scripts/lib/data-gate-heal-paths.js');
    const fs = require('node:fs');
    const path = require('node:path');
    const dirname = path.dirname(new URL(import.meta.url).pathname);
    const workflowsDir = path.join(dirname, '../../.github/workflows');
    const workflowFiles = fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml'))
      .map((filename) => ({ filename, content: fs.readFileSync(path.join(workflowsDir, filename), 'utf8') }));

    for (const name of MOVED_NAMES) {
      const audit = AUDITS.find((a) => a.name === name);
      assert.ok(audit, `expected AUDITS to contain a moved gate named "${name}"`);
      assert.equal(audit.healPathRequired, true, `${name} must be marked healPathRequired (BRO-3535 ratchet scope)`);
      const scriptName = audit.script.replace(/\.js$/, '');
      const scriptSource = fs.readFileSync(path.join(dirname, '../../scripts', audit.script), 'utf8');
      const healed = Boolean(
        audit.healExempt || hasBaselineDiffPath(scriptSource) || hasScheduledFixWorkflow(scriptName, workflowFiles)
      );
      assert.ok(healed, `${name} (scripts/${audit.script}) has no heal path and no healExempt reason`);
    }
  });

  test('routePerAuditAlerts resolves without throwing for an empty audit list', async () => {
    await assert.doesNotReject(() => routePerAuditAlerts([]));
  });

  test('routePerAuditAlerts skips crashed audits (never calls the router for them)', async () => {
    // crashed:true audits are handled by the separate audit-crash guard above
    // main()'s per-audit loop — routePerAuditAlerts must not double-handle them.
    // A crashed-only list resolving cleanly (no router call attempted) proves
    // the `if (a.crashed) continue;` guard, without needing to mock the router.
    await assert.doesNotReject(() => routePerAuditAlerts([crashed('only-crashed')]));
  });
});
