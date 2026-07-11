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
const { evaluateAuditReport } = require('../../scripts/audit-dependencies');

const ALLOW = [{ ghsa: 'GHSA-mp2f-45pm-3cg9', module: 'decompress', reason: 'no patched release', expires: '2099-01-01' }];
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
