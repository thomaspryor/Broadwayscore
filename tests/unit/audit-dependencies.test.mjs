/**
 * Dependency-audit allowlist gate (scripts/audit-dependencies.js).
 *
 * Regression shapes from the 2026-07-11 ship-check of the first version:
 *  - registry outage JSON ({"error":...} / missing vulnerabilities) went green
 *  - a moderate advisory sharing a package with an allowlisted critical
 *    false-positived the "critical-only" gate
 *  - a critical two transitive hops away escaped the one-level walk
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { evaluateAuditReport, ALLOWLIST, MIN_EXPOSURE_CHARS } = require('../../scripts/audit-dependencies');

const EXPOSURE = 'Not exposed: dev-time CLI toolchain only, never bundled into the site runtime.';
const ALLOW = [{
  ghsa: 'GHSA-mp2f-45pm-3cg9', module: 'decompress', reason: 'no patched release',
  exposure: EXPOSURE, expires: '2099-01-01',
}];
const TODAY = '2026-07-11';

const criticalVia = (ghsa, title = 't') => ({
  source: 1, name: 'x', title, severity: 'critical',
  url: `https://github.com/advisories/${ghsa}`, range: '*',
});

describe('evaluateAuditReport', () => {
  test('clean report passes', () => {
    const r = evaluateAuditReport({ vulnerabilities: {} }, ALLOW, TODAY);
    assert.equal(r.ok, true);
  });

  test('allowlisted critical passes and is surfaced', () => {
    const report = { vulnerabilities: { decompress: { severity: 'critical', via: [criticalVia('GHSA-mp2f-45pm-3cg9')] } } };
    const r = evaluateAuditReport(report, ALLOW, TODAY);
    assert.equal(r.ok, true);
    assert.equal(r.allowedHits.length, 1);
  });

  test('unallowlisted critical fails', () => {
    const report = { vulnerabilities: { evil: { severity: 'critical', via: [criticalVia('GHSA-xxxx-yyyy-zzzz')] } } };
    const r = evaluateAuditReport(report, ALLOW, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /GHSA-xxxx-yyyy-zzzz/);
  });

  test('moderate advisory sharing a package with an allowlisted critical does NOT fail the critical gate', () => {
    const report = {
      vulnerabilities: {
        decompress: {
          severity: 'critical',
          via: [
            criticalVia('GHSA-mp2f-45pm-3cg9'),
            { name: 'x', title: 'moderate thing', severity: 'moderate', url: 'https://github.com/advisories/GHSA-mmmm-oooo-dddd' },
          ],
        },
      },
    };
    const r = evaluateAuditReport(report, ALLOW, TODAY);
    assert.equal(r.ok, true, `false positive on non-critical advisory: ${r.errors.join('; ')}`);
  });

  test('critical two transitive hops away is caught (per-advisory scan, no walk)', () => {
    // A -> "B" -> "C"; the critical advisory object lives on C's entry.
    const report = {
      vulnerabilities: {
        A: { severity: 'critical', via: ['B'] },
        B: { severity: 'high', via: ['C'] },
        C: { severity: 'critical', via: [criticalVia('GHSA-deep-deep-deep')] },
      },
    };
    const r = evaluateAuditReport(report, ALLOW, TODAY);
    assert.equal(r.ok, false, 'deep transitive critical must fail');
  });

  test('expired allowlist entry fails', () => {
    const expired = [{ ...ALLOW[0], expires: '2026-01-01' }];
    const report = { vulnerabilities: {} };
    const r = evaluateAuditReport(report, expired, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /expired/);
  });

  test('npm error report fails instead of passing green', () => {
    const r = evaluateAuditReport({ error: { code: 'ENOAUDIT', summary: 'registry unreachable' } }, ALLOW, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /errored/);
  });

  test('report with no vulnerabilities object fails (not silently clean)', () => {
    const r = evaluateAuditReport({ auditReportVersion: 2 }, ALLOW, TODAY);
    assert.equal(r.ok, false);
  });
});

// BRO-3202: two unpatched critical Next.js RCEs were about to be allowlisted
// with no written statement of whether they could reach this deployment. A
// blank exemption is indistinguishable from `|| true`, so the gate refuses it.
describe('exposure assessment is mandatory', () => {
  const withExposure = (exposure) => [{ ...ALLOW[0], exposure }];

  test('entry missing exposure fails even on an otherwise clean report', () => {
    const noExposure = [{ ghsa: 'GHSA-mp2f-45pm-3cg9', module: 'decompress', reason: 'r', expires: '2099-01-01' }];
    const r = evaluateAuditReport({ vulnerabilities: {} }, noExposure, TODAY);
    assert.equal(r.ok, false, 'a blank exemption must not pass');
    assert.match(r.errors[0], /exposure/);
  });

  test('hand-wave exposure shorter than the minimum fails', () => {
    const r = evaluateAuditReport({ vulnerabilities: {} }, withExposure('n/a'), TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], new RegExp(String(MIN_EXPOSURE_CHARS)));
  });

  test('whitespace-only exposure fails', () => {
    const r = evaluateAuditReport({ vulnerabilities: {} }, withExposure(' '.repeat(200)), TODAY);
    assert.equal(r.ok, false);
  });

  test('a missing exposure is not masked by an allowlist hit', () => {
    const noExposure = [{ ghsa: 'GHSA-mp2f-45pm-3cg9', module: 'decompress', reason: 'r', expires: '2099-01-01' }];
    const report = { vulnerabilities: { decompress: { severity: 'critical', via: [criticalVia('GHSA-mp2f-45pm-3cg9')] } } };
    const r = evaluateAuditReport(report, noExposure, TODAY);
    assert.equal(r.ok, false);
    assert.equal(r.allowedHits.length, 0);
  });

  test('the real shipped ALLOWLIST satisfies its own rule', () => {
    for (const entry of ALLOWLIST) {
      assert.ok(typeof entry.exposure === 'string' && entry.exposure.trim().length >= MIN_EXPOSURE_CHARS,
        `${entry.ghsa} has no usable exposure assessment`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(entry.expires), `${entry.ghsa} has a malformed expiry`);
    }
  });

  test('both Next.js RCE advisories are allowlisted with an exposure assessment', () => {
    for (const ghsa of ['GHSA-p293-qw3h-jr36', 'GHSA-2xp9-vwfh-vxw4']) {
      const entry = ALLOWLIST.find((a) => a.ghsa === ghsa);
      assert.ok(entry, `${ghsa} missing from ALLOWLIST`);
      assert.equal(entry.module, 'next');
    }
  });
});
