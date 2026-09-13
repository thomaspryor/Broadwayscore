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
const { evaluateAuditReport, ALLOWLIST, MIN_EXPOSURE_CHARS, ISSUE_RE, isValidExpiry } = require('../../scripts/audit-dependencies');

const EXPOSURE = 'Not exposed: dev-time CLI toolchain only, never bundled into the site runtime.';
const ALLOW = [{
  ghsa: 'GHSA-mp2f-45pm-3cg9', module: 'decompress', reason: 'no patched release',
  exposure: EXPOSURE, issue: 'BRO-3202', expires: '2099-01-01',
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


// --- BRO-3202 ship-check (Codex finding): a disqualified entry must not change
// WHICH problems the run reports. The first version returned as soon as the
// allowlist looked wrong, so one stale entry could hide a live RCE elsewhere in
// the tree until someone fixed the prose and pushed again.
describe('a disqualified entry never hides a real finding', () => {
  const good = ALLOW[0];
  const shortExposure = { ...good, exposure: 'too short' };
  const expiredEntry = { ...good, expires: '2026-01-01' };
  const noIssue = { ...good, issue: undefined };

  const brandNewCritical = {
    vulnerabilities: {
      next: { severity: 'critical', via: [criticalVia('GHSA-9999-9999-9999', 'Unauthenticated RCE')] },
    },
  };

  for (const [label, entry] of [
    ['a too-short exposure', shortExposure],
    ['a missing issue reference', noIssue],
    ['an expired entry', expiredEntry],
  ]) {
    test(`${label} still reports the unallowlisted critical in the SAME run`, () => {
      const r = evaluateAuditReport(brandNewCritical, [entry], TODAY);
      assert.equal(r.ok, false);
      const joined = r.errors.join(' | ');
      assert.match(joined, /GHSA-9999-9999-9999/, `the actionable RCE must not be hidden: ${joined}`);
      assert.ok(r.errors.length >= 2, `both the allowlist problem and the RCE must be reported: ${joined}`);
    });
  }

  test('a disqualified entry stops exempting its OWN advisory too', () => {
    const report = {
      vulnerabilities: { decompress: { severity: 'critical', via: [criticalVia(good.ghsa)] } },
    };
    const r = evaluateAuditReport(report, [shortExposure], TODAY);
    assert.equal(r.ok, false);
    assert.equal(r.allowedHits.length, 0, 'a malformed entry must not still grant its exemption');
    assert.match(r.errors.join(' | '), new RegExp(good.ghsa), 'its advisory must resurface as unallowlisted');
  });

  test('an expired entry stops exempting its own advisory (was: reported expiry, exempted anyway)', () => {
    const report = {
      vulnerabilities: { decompress: { severity: 'critical', via: [criticalVia(good.ghsa)] } },
    };
    const r = evaluateAuditReport(report, [expiredEntry], TODAY);
    assert.equal(r.ok, false);
    assert.equal(r.allowedHits.length, 0);
    const joined = r.errors.join(' | ');
    assert.match(joined, /expired/);
    assert.match(joined, /not in allowlist/, 'the advisory itself must also be reported');
  });

  test('a valid entry beside a disqualified one keeps working', () => {
    const other = {
      ghsa: 'GHSA-aaaa-bbbb-cccc', module: 'other', reason: 'r',
      exposure: EXPOSURE, issue: 'BRO-1', expires: '2099-01-01',
    };
    const report = {
      vulnerabilities: { other: { severity: 'critical', via: [criticalVia(other.ghsa)] } },
    };
    const r = evaluateAuditReport(report, [shortExposure, other], TODAY);
    assert.equal(r.allowedHits.length, 1, 'one bad entry must not void the rest of the allowlist');
    assert.equal(r.allowedHits[0].ghsa, other.ghsa);
  });
});

describe('every exemption cites a tracked issue', () => {
  test('an entry with no issue reference fails', () => {
    const r = evaluateAuditReport({ vulnerabilities: {} }, [{ ...ALLOW[0], issue: undefined }], TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /issue/);
  });

  test('an issue reference that is not a Linear id fails', () => {
    for (const bad of ['see slack', 'BRO-', '3202', 'https://linear.app/x/BRO-1']) {
      const r = evaluateAuditReport({ vulnerabilities: {} }, [{ ...ALLOW[0], issue: bad }], TODAY);
      assert.equal(r.ok, false, `"${bad}" should not pass as an issue reference`);
    }
  });

  test('the real shipped ALLOWLIST cites a tracked issue for every entry', () => {
    for (const entry of ALLOWLIST) {
      assert.ok(ISSUE_RE.test(String(entry.issue || '').trim()), `${entry.ghsa} has no Linear issue reference`);
    }
  });
});

// --- BRO-3202 ship-check: `expires` was the ONLY mechanism forcing re-triage of
// the two Next.js RCEs, and it was the one field nobody validated. It is
// compared as a STRING against today, so a plausible typo doesn't read as
// "expired" — it reads as "never expires", permanently and silently.
describe('expiry is validated, not trusted', () => {
  const withExpiry = (expires) => [{ ...ALLOW[0], expires }];

  test('a missing expires does not become a permanent silent exemption', () => {
    // `undefined <= '2026-07-11'` is false, i.e. the old code read this as
    // "expires in the future" forever.
    const r = evaluateAuditReport({ vulnerabilities: {} }, [{ ...ALLOW[0], expires: undefined }], TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /expires/);
  });

  test('a non-ISO past date is rejected rather than read as the future', () => {
    // '2026-9-1' <= '2026-07-11' is false by string compare, despite being a
    // date well in the past.
    const r = evaluateAuditReport({ vulnerabilities: {} }, withExpiry('2026-9-1'), TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /expires/);
  });

  test('a Date object is rejected (comparison against a string is meaningless)', () => {
    const r = evaluateAuditReport({ vulnerabilities: {} }, withExpiry(new Date('2099-01-01')), TODAY);
    assert.equal(r.ok, false);
  });

  test('an entry with an invalid expiry stops exempting its advisory', () => {
    const report = { vulnerabilities: { decompress: { severity: 'critical', via: [criticalVia(ALLOW[0].ghsa)] } } };
    const r = evaluateAuditReport(report, withExpiry(undefined), TODAY);
    assert.equal(r.allowedHits.length, 0);
    assert.match(r.errors.join(' | '), /not in allowlist/);
  });

  test('isValidExpiry rejects dates that do not exist', () => {
    assert.equal(isValidExpiry('2026-02-30'), false);
    assert.equal(isValidExpiry('2026-13-01'), false);
    assert.equal(isValidExpiry('2026-11-15'), true);
  });
});

describe('duplicate allowlist entries', () => {
  test('two entries for the same GHSA are an error, not a silent last-wins', () => {
    const dup = [ALLOW[0], { ...ALLOW[0], exposure: `${EXPOSURE} (a stale second copy)` }];
    const report = { vulnerabilities: { decompress: { severity: 'critical', via: [criticalVia(ALLOW[0].ghsa)] } } };
    const r = evaluateAuditReport(report, dup, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' | '), /2 entries for GHSA-mp2f-45pm-3cg9/);
    assert.equal(r.allowedHits.length, 0, 'a shadowed exemption must not still apply');
  });

  test('the real shipped ALLOWLIST has no duplicate GHSA ids', () => {
    const ids = ALLOWLIST.map((a) => a.ghsa);
    assert.equal(new Set(ids).size, ids.length);
  });
});
