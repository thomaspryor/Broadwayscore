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


// --- BRO-4434: the audit left test.yml (main's color = code only). It now runs
// daily with --alert and files cards. These pin the parts that make that safe:
// structured findings (stable conditionKeys), the expiring-soon window, the
// exit-code table, and --alert's handling of the REAL router contract
// (routeAlert resolves { dispatchOk:false } on failure — it never throws).
const {
  decideExitCode, runAlerts, parseArgs, findingKey, expiringKey, CONDITION_PREFIX,
  VERIFY_CLEAN, VERIFY_NO_EXPIRING,
} = require('../../scripts/audit-dependencies');

describe('structured findings (BRO-4434)', () => {
  test('an unallowlisted critical is a finding keyed by its GHSA, and errors mirrors findings', () => {
    const report = { vulnerabilities: { evil: { severity: 'critical', via: [criticalVia('GHSA-xxxx-yyyy-zzzz')] } } };
    const r = evaluateAuditReport(report, ALLOW, TODAY);
    assert.deepEqual(r.findings.map((f) => [f.kind, f.ghsa, f.module]), [['unallowlisted', 'GHSA-xxxx-yyyy-zzzz', 'evil']]);
    assert.deepEqual(r.errors, r.findings.map((f) => f.message));
    assert.equal(r.couldNotRun, false);
  });

  test('each disqualification kind is a distinct finding on the entry\'s own GHSA', () => {
    const cases = [
      ['missing-exposure', { ...ALLOW[0], exposure: 'nope' }],
      ['missing-issue', { ...ALLOW[0], issue: 'task 12' }],
      ['invalid-expiry', { ...ALLOW[0], expires: '2026-13-40' }],
      ['expired', { ...ALLOW[0], expires: '2026-01-01' }],
    ];
    for (const [kind, entry] of cases) {
      const r = evaluateAuditReport({ vulnerabilities: {} }, [entry], TODAY);
      assert.deepEqual(r.findings.map((f) => [f.kind, f.ghsa]), [[kind, ALLOW[0].ghsa]], kind);
    }
    const dup = evaluateAuditReport({ vulnerabilities: {} }, [ALLOW[0], { ...ALLOW[0] }], TODAY);
    assert.deepEqual(dup.findings.map((f) => f.kind), ['duplicate-entry']);
  });

  test('could-not-run shapes are flagged as such, with no findings', () => {
    for (const bad of [null, { error: { code: 'ENOAUDIT', summary: 'down' } }, { auditReportVersion: 2 }]) {
      const r = evaluateAuditReport(bad, ALLOW, TODAY);
      assert.equal(r.couldNotRun, true);
      assert.equal(r.ok, false);
      assert.deepEqual(r.findings, []);
      assert.deepEqual(r.expiringSoon, []);
    }
  });
});

describe('expiring-soon window (BRO-4434)', () => {
  const entry = (expires) => [{ ...ALLOW[0], expires }];
  const clean = { vulnerabilities: {} };

  test('off by default: warnDays 0 never lists anything', () => {
    const r = evaluateAuditReport(clean, entry('2026-07-12'), TODAY);
    assert.deepEqual(r.expiringSoon, []);
  });

  test('inside the window is listed with daysLeft; never affects ok', () => {
    const r = evaluateAuditReport(clean, entry('2026-07-20'), TODAY, { warnDays: 14 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.expiringSoon, [{ ghsa: ALLOW[0].ghsa, module: 'decompress', expires: '2026-07-20', daysLeft: 9 }]);
  });

  test('boundary is inclusive: today+warnDays is listed, today+warnDays+1 is not (the 2026-09-30 off-by-one)', () => {
    // TODAY = 2026-07-11: +14 = 07-25 (in), +15 = 07-26 (out).
    assert.equal(evaluateAuditReport(clean, entry('2026-07-25'), TODAY, { warnDays: 14 }).expiringSoon.length, 1);
    assert.equal(evaluateAuditReport(clean, entry('2026-07-26'), TODAY, { warnDays: 14 }).expiringSoon.length, 0);
  });

  test('tomorrow is 1 day left, never 0', () => {
    const r = evaluateAuditReport(clean, entry('2026-07-12'), TODAY, { warnDays: 14 });
    assert.equal(r.expiringSoon[0].daysLeft, 1);
  });

  test('an expired or malformed entry is a finding, NOT an expiring-soon reminder', () => {
    for (const expires of ['2026-07-11', '2026-01-01', 'soon']) {
      const r = evaluateAuditReport(clean, entry(expires), TODAY, { warnDays: 14 });
      assert.deepEqual(r.expiringSoon, [], expires);
      assert.equal(r.findings.length, 1, expires);
    }
  });
});

describe('decideExitCode (BRO-4434) — the audit-time-bomb-tests contract', () => {
  test('table', () => {
    assert.equal(decideExitCode({}).exitCode, 0);
    assert.equal(decideExitCode({ findingsCount: 2 }).exitCode, 0, 'findings alone are reported, not fatal');
    assert.equal(decideExitCode({ findingsCount: 2, strict: true }).exitCode, 1);
    assert.equal(decideExitCode({ couldNotRun: true, findingsCount: 2, strict: true, alertDispatchFailed: true }).exitCode, 2, 'could-not-run wins');
    assert.equal(decideExitCode({ findingsCount: 2, strict: true, alertDispatchFailed: true }).exitCode, 3, 'a lost alert beats --strict');
    assert.equal(decideExitCode({ alertDispatchFailed: true }).exitCode, 3);
    assert.match(decideExitCode({ findingsCount: 1 }).reason, /1 finding/);
  });
});

describe('parseArgs (BRO-4434)', () => {
  test('parses flags and rejects junk loudly', () => {
    assert.deepEqual(parseArgs(['--strict', '--alert', '--warn-days=14', '--out=/tmp/x.json']),
      { strict: true, alert: true, warnDays: 14, out: '/tmp/x.json', help: false });
    assert.throws(() => parseArgs(['--warn-days=soon']), /non-negative integer/);
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  });
});

// A fake router with the SAME contract as scripts/lib/owner-alert-router.js:
// routeAlert resolves (never throws) with { action, dispatchOk, linearIdentifier };
// resolveCondition on an unknown/non-open key is a no-op returning false.
function fakeRouter({ conditions = {}, respond } = {}) {
  const calls = [];
  const resolved = [];
  return {
    calls,
    resolved,
    loadLedger: () => ({ conditions }),
    resolveCondition: (key) => {
      resolved.push(key);
      const c = conditions[key];
      if (!c || c.status !== 'open') return false;
      c.status = 'resolved';
      return true;
    },
    routeAlert: async (opts) => {
      calls.push(opts);
      return respond ? respond(opts) : { action: 'auto', dispatchOk: true, linearIdentifier: `BRO-${9000 + calls.length}` };
    },
  };
}

describe('runAlerts (BRO-4434) against the real router contract', () => {
  const finding = { kind: 'unallowlisted', ghsa: 'GHSA-aaaa-bbbb-cccc', module: 'evil', message: 'critical advisory not in allowlist — evil: bad (url)' };
  const expiring = { ghsa: ALLOW[0].ghsa, module: 'decompress', expires: '2026-07-20', daysLeft: 9 };

  test('a finding files a dispatched-at-filing card with a safe-form VERIFY line; expiring-soon files a PARKED one', async () => {
    const router = fakeRouter();
    const r = await runAlerts({ findings: [finding], expiringSoon: [expiring], allowlist: ALLOW, router, runContext: { runId: '123', runUrl: 'https://x/runs/123' }, log: () => {} });
    assert.equal(r.alertDispatchFailed, false);
    assert.equal(router.calls.length, 2);
    const [f, e] = router.calls;
    assert.equal(f.conditionKey, findingKey(finding.ghsa));
    assert.equal(f.disposition, 'auto');
    assert.deepEqual(f.dispatchAtFiling, { runId: '123', runUrl: 'https://x/runs/123' });
    assert.equal(f.verify.line, VERIFY_CLEAN);
    assert.match(f.verify.line, /^VERIFY: node --test tests\/live\/[\w-]+\.test\.mjs$/, 'VERIFY: prefix + a SAFE_CHECK_FORM, or the drain never selects the card');
    assert.match(f.title, /^Security issue in evil — needs a decision \(GHSA-aaaa-bbbb-cccc\)$/, 'plain words first, id last');
    assert.match(f.description, /^A helper session is assigned/, 'first line says who acts');
    assert.equal(e.conditionKey, expiringKey(expiring.ghsa));
    assert.equal(e.dispatchAtFiling, undefined, 'extending an exemption is a judgment call — parked, not dispatched');
    assert.equal(e.verify.line, VERIFY_NO_EXPIRING);
    assert.match(e.title, /^Security exception for decompress ends on 2026-07-20 — extend or fix \(GHSA-mp2f-45pm-3cg9\)$/);
    assert.match(e.description, /^Nothing breaks on 2026-07-20/, 'first line says what ignoring it means');
    assert.match(e.description, /9 day\(s\) ahead/);
    assert.deepEqual(r.alerts.map((a) => a.linearIdentifier), ['BRO-9001', 'BRO-9002']);
  });

  test('outside CI (no runId) the finding card is parked too, never a half-formed dispatchAtFiling', async () => {
    const router = fakeRouter();
    await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.equal(router.calls[0].dispatchAtFiling, undefined);
  });

  test('dispatchOk:false counts as a failure even though the router did not throw (pre-mortem P0)', async () => {
    const router = fakeRouter({ respond: () => ({ action: 'auto', dispatchOk: false, dispatchError: 'authentication required' }) });
    const logged = [];
    const r = await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: (m) => logged.push(m) });
    assert.equal(r.alertDispatchFailed, true);
    assert.equal(r.alerts[0].dispatchOk, false);
    assert.match(logged.join('\n'), /authentication required/);
  });

  test('an "auto" result with no tracker identifier is a failure too', async () => {
    const router = fakeRouter({ respond: () => ({ action: 'auto', dispatchOk: true }) });
    const r = await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.equal(r.alertDispatchFailed, true);
  });

  test('a silent result that names NO tracker is a failure (the ledger claims a card nothing can point at)', async () => {
    const router = fakeRouter({ respond: () => ({ action: 'silent', linearIdentifier: null }) });
    const r = await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.equal(r.alertDispatchFailed, true);
  });

  test('a cooldown-silent result with an existing tracker is NOT a failure', async () => {
    const router = fakeRouter({ respond: () => ({ action: 'silent', linearIdentifier: 'BRO-1' }) });
    const r = await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.equal(r.alertDispatchFailed, false);
    assert.equal(r.alerts[0].linearIdentifier, 'BRO-1');
  });

  test('a throwing router is caught, counted, and does not stop the other alerts', async () => {
    let n = 0;
    const router = fakeRouter({ respond: () => { if (++n === 1) throw new Error('boom'); return { action: 'auto', dispatchOk: true, linearIdentifier: 'BRO-2' }; } });
    const r = await runAlerts({ findings: [finding], expiringSoon: [expiring], allowlist: ALLOW, router, log: () => {} });
    assert.equal(r.alertDispatchFailed, true);
    assert.equal(r.alerts.length, 2);
    assert.equal(r.alerts[1].linearIdentifier, 'BRO-2');
  });

  test('opening a finding for a GHSA resolves that GHSA\'s parked expiring reminder (no false pair after the expiry date)', async () => {
    const key = expiringKey(ALLOW[0].ghsa);
    const router = fakeRouter({ conditions: { [key]: { status: 'open' } } });
    const expiredFinding = { kind: 'expired', ghsa: ALLOW[0].ghsa, module: 'decompress', message: 'expired allowlist entry' };
    await runAlerts({ findings: [expiredFinding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.ok(router.resolved.includes(key));
    assert.equal(router.loadLedger().conditions[key].status, 'resolved');
    // the finding card carries the entry's exposure/issue so the dispatched session sees the prior decision
    assert.match(router.calls[0].description, /exposure: Not exposed/);
    assert.match(router.calls[0].description, /issue: BRO-3202/);
  });

  test('a clean run sweep-resolves every open dependency-audit: key and touches nothing else', async () => {
    const stale = findingKey('GHSA-gone-gone-gone');
    const staleExp = expiringKey('GHSA-gone-gone-gone');
    const other = 'time-bomb-tests:x';
    const router = fakeRouter({ conditions: {
      [stale]: { status: 'open' }, [staleExp]: { status: 'open' }, [other]: { status: 'open' },
      [findingKey('GHSA-resolved-already')]: { status: 'resolved' },
    } });
    // warnDays > 0: a windowed run is authoritative for the expiring keys too
    const r = await runAlerts({ findings: [], expiringSoon: [], allowlist: ALLOW, router, warnDays: 14, log: () => {} });
    assert.equal(r.alertDispatchFailed, false);
    assert.equal(router.calls.length, 0);
    assert.deepEqual(router.resolved.sort(), [stale, staleExp].sort());
    assert.equal(router.loadLedger().conditions[other].status, 'open');
  });

  test('a key still reported this run is NOT swept', async () => {
    const key = findingKey(finding.ghsa);
    const router = fakeRouter({ conditions: { [key]: { status: 'open' } }, respond: () => ({ action: 'silent', linearIdentifier: 'BRO-5' }) });
    await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.ok(!router.resolved.includes(key));
  });

  test('every key this script opens starts with the sweep prefix', () => {
    assert.ok(findingKey('X').startsWith(CONDITION_PREFIX));
    assert.ok(expiringKey('X').startsWith(CONDITION_PREFIX));
    assert.notEqual(findingKey('X'), expiringKey('X'));
  });
});

// Ship-check P0 (BRO-3881 class): a bare command in verify.line is prose to
// extractVerifyCmd(); the card reads "no-safe-verify" and neither the
// red-first dispatcher nor the parked drain ever picks it up. Go through the
// REAL card-notes builder and the REAL verifiability gate (CLAUDE.md §15).
describe('the filed cards are dispatchable end to end (BRO-4434)', () => {
  const { buildCardNotes } = require('../../scripts/lib/owner-alert-router');
  const { evaluateVerifiability } = require('../../scripts/lib/verify-gate');

  for (const [label, line] of [['finding card', VERIFY_CLEAN], ['expiring reminder', VERIFY_NO_EXPIRING]]) {
    test(`${label}: buildCardNotes + evaluateVerifiability arm on the VERIFY line`, () => {
      const notes = buildCardNotes({ description: 'd', hint: 'h', fields: [], conditionKey: 'dependency-audit:GHSA-x', verify: { line, note: 'n' } });
      const v = evaluateVerifiability(notes, []);
      assert.equal(v.armed, true, `${label} not armed: ${JSON.stringify(v)}`);
    });
  }

  test('a bare command (no VERIFY: prefix) would NOT arm — the regression this pins', () => {
    const notes = buildCardNotes({ description: 'd', hint: 'h', fields: [], conditionKey: 'k', verify: { line: VERIFY_CLEAN.replace(/^VERIFY: /, ''), note: 'n' } });
    assert.equal(evaluateVerifiability(notes, []).armed, false);
  });
});

describe('runAlerts hygiene (ship-check P2s, BRO-4434)', () => {
  const dup = (kind) => ({ kind, ghsa: 'GHSA-dupe-dupe-dupe', module: 'm', message: kind });

  test('several findings on one GHSA file ONE card', async () => {
    const router = fakeRouter();
    const r = await runAlerts({ findings: [dup('missing-issue'), dup('duplicate-entry')], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.equal(router.calls.length, 1);
    assert.equal(r.alerts.length, 1);
  });

  test('a run with no warning window leaves open expiring reminders alone; a windowed run sweeps them', async () => {
    const key = expiringKey('GHSA-gone-gone-gone');
    const mk = () => fakeRouter({ conditions: { [key]: { status: 'open' } } });
    const r0 = mk();
    await runAlerts({ findings: [], expiringSoon: [], allowlist: ALLOW, router: r0, warnDays: 0, log: () => {} });
    assert.equal(r0.loadLedger().conditions[key].status, 'open');
    const r14 = mk();
    await runAlerts({ findings: [], expiringSoon: [], allowlist: ALLOW, router: r14, warnDays: 14, log: () => {} });
    assert.equal(r14.loadLedger().conditions[key].status, 'resolved');
  });

  test('the expiring reminder is resolved even when routeAlert throws for the finding', async () => {
    const key = expiringKey('GHSA-thrw-thrw-thrw');
    const router = fakeRouter({ conditions: { [key]: { status: 'open' } }, respond: () => { throw new Error('boom'); } });
    const finding = { kind: 'expired', ghsa: 'GHSA-thrw-thrw-thrw', module: 'm', message: 'expired' };
    const r = await runAlerts({ findings: [finding], expiringSoon: [], allowlist: ALLOW, router, log: () => {} });
    assert.equal(r.alertDispatchFailed, true);
    assert.equal(router.loadLedger().conditions[key].status, 'resolved');
  });
});
