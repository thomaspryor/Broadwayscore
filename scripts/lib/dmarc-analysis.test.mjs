// scripts/lib/dmarc-analysis.test.mjs
//
// Tests the real analysis functions (CLAUDE.md rule 15 — require()d, not
// restated). The findings here are the product: the ingest exists so that a
// spoofing source or a broken sender becomes an alert instead of an unread
// attachment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  summarizeReports,
  reportKey,
  evaluateFindings,
  classifySource,
  buildPolicyTimeline,
  worstSeverity,
  dmarcHealthResult,
  formatSummary,
} = require('./dmarc-analysis.js');

const POLICY = { domain: 'broadwayscorecard.com', adkim: 'r', aspf: 'r', p: 'quarantine', sp: 'quarantine', np: '', pct: 100 };

function record(over = {}) {
  return {
    sourceIp: '54.240.9.36',
    count: 10,
    disposition: 'none',
    evaluatedDkim: 'pass',
    evaluatedSpf: 'pass',
    overrides: [],
    headerFrom: 'broadwayscorecard.com',
    envelopeFrom: '',
    envelopeTo: '',
    dkim: [{ domain: 'broadwayscorecard.com', result: 'pass', selector: 'resend' }],
    spf: [{ domain: 'send.broadwayscorecard.com', result: 'pass', scope: 'mfrom' }],
    ...over,
  };
}

function report(over = {}) {
  const records = over.records || [record()];
  return {
    orgName: 'google.com',
    orgEmail: 'noreply-dmarc-support@google.com',
    reportId: 'r1',
    dateBegin: '2026-08-01T00:00:00.000Z',
    dateEnd: '2026-08-01T23:59:59.000Z',
    policy: { ...POLICY },
    messageCount: records.reduce((n, r) => n + r.count, 0),
    ...over,
    records,
  };
}

test('summarizeReports: totals, pass rate and auth split', () => {
  const s = summarizeReports([
    report({ reportId: 'a', records: [record({ count: 10 })] }),
    report({ reportId: 'b', records: [record({ count: 5, evaluatedSpf: 'fail' })] }),
  ]);
  assert.equal(s.messages.total, 15);
  assert.equal(s.messages.pass, 15);
  assert.equal(s.messages.fail, 0);
  assert.equal(s.messages.passRate, 1);
  assert.equal(s.authSplit.both, 10);
  assert.equal(s.authSplit.dkimOnly, 5, 'SPF-failed but DKIM-passed mail is forwarded mail');
});

test('summarizeReports: deduplicates the same report_id from the same reporter', () => {
  // Microsoft delivers a "Preview" and a final copy of the same run; counting
  // both would silently double every total.
  const s = summarizeReports([
    report({ reportId: 'dup', records: [record({ count: 100 })] }),
    report({ reportId: 'dup', records: [record({ count: 100 })] }),
  ]);
  assert.equal(s.reportCount, 1);
  assert.equal(s.duplicatesDropped, 1);
  assert.equal(s.messages.total, 100);
});

test('a report with NO report_id still deduplicates, by covered range', () => {
  // Regression: keyed on report_id alone, an id-less report was re-counted on
  // every ingest run (~30 times over a 30-day lookback), inflating the message
  // total and diluting the failure rate toward zero — a monitor lying in the
  // safe-looking direction.
  const idless = () => report({ reportId: '', records: [record({ count: 100 })] });
  const s = summarizeReports([idless(), idless(), idless()]);
  assert.equal(s.reportCount, 1);
  assert.equal(s.duplicatesDropped, 2);
  assert.equal(s.messages.total, 100);
});

test('id-less reports covering DIFFERENT ranges are distinct', () => {
  const s = summarizeReports([
    report({ reportId: '', dateBegin: '2026-08-01T00:00:00.000Z', dateEnd: '2026-08-01T23:59:59.000Z', records: [record({ count: 5 })] }),
    report({ reportId: '', dateBegin: '2026-08-02T00:00:00.000Z', dateEnd: '2026-08-02T23:59:59.000Z', records: [record({ count: 7 })] }),
  ]);
  assert.equal(s.reportCount, 2);
  assert.equal(s.messages.total, 12);
});

test('reportKey: prefers report_id, falls back to reporter + range', () => {
  assert.equal(reportKey({ orgName: 'google.com', reportId: '42', dateBegin: 'a', dateEnd: 'b' }), 'google.com|id:42');
  assert.equal(reportKey({ orgName: 'google.com', reportId: '', dateBegin: 'a', dateEnd: 'b' }), 'google.com|range:a|b');
});

test('policy-upgrade-available uses lifetime evidence when supplied', () => {
  // The cron fetches a short recent window; without lifetime context the
  // 30-day/1000-message evidence bar could never be met and this finding
  // would never fire in production.
  const shortWindow = [report({ records: [record({ count: 12 })] })];
  assert.equal(
    summarizeReports(shortWindow).findings.some((f) => f.code === 'policy-upgrade-available'),
    false,
    'one day of 12 messages is not evidence',
  );
  const withLifetime = summarizeReports(shortWindow, {
    lifetime: { messages: 12633, failures: 0, spanDays: 170 },
  });
  const f = withLifetime.findings.find((x) => x.code === 'policy-upgrade-available');
  assert.ok(f, 'lifetime history supplies the evidence');
  assert.equal(f.evidence.basis, 'lifetime-ledger');
  assert.equal(f.evidence.total, 12633);
});

test('lifetime evidence with any failure blocks the upgrade suggestion', () => {
  const s = summarizeReports([report({ records: [record({ count: 12 })] })], {
    lifetime: { messages: 12633, failures: 1, spanDays: 170 },
  });
  assert.equal(s.findings.some((f) => f.code === 'policy-upgrade-available'), false);
});

test('summarizeReports: same report_id from DIFFERENT reporters both count', () => {
  const s = summarizeReports([
    report({ orgName: 'google.com', reportId: 'x', records: [record({ count: 3 })] }),
    report({ orgName: 'Outlook.com', reportId: 'x', records: [record({ count: 4 })] }),
  ]);
  assert.equal(s.reportCount, 2);
  assert.equal(s.messages.total, 7);
});

test('summarizeReports: per-source aggregation merges across reports', () => {
  const s = summarizeReports([
    report({ reportId: 'a', dateBegin: '2026-08-01T00:00:00.000Z', dateEnd: '2026-08-01T23:59:59.000Z', records: [record({ count: 2 })] }),
    report({ reportId: 'b', dateBegin: '2026-08-05T00:00:00.000Z', dateEnd: '2026-08-05T23:59:59.000Z', records: [record({ count: 3 })] }),
  ]);
  assert.equal(s.sources.length, 1);
  assert.equal(s.sources[0].count, 5);
  assert.equal(s.sources[0].firstSeen, '2026-08-01T00:00:00.000Z');
  assert.equal(s.sources[0].lastSeen, '2026-08-05T23:59:59.000Z');
});

test('an unauthenticated sender using our domain is an actionable finding', () => {
  const spoof = record({
    sourceIp: '203.0.113.9',
    count: 40,
    evaluatedDkim: 'fail',
    evaluatedSpf: 'fail',
    disposition: 'quarantine',
    dkim: [],
    spf: [{ domain: 'evil.example', result: 'fail', scope: 'mfrom' }],
  });
  const s = summarizeReports([report({ records: [record({ count: 10 }), spoof] })]);

  assert.equal(s.messages.fail, 40);
  const finding = s.findings.find((f) => f.code === 'unauthenticated-source');
  assert.ok(finding, 'a spoofing source must produce a finding');
  assert.equal(finding.severity, 'action');
  assert.equal(finding.evidence.ip, '203.0.113.9');
  assert.equal(finding.evidence.fail, 40);
  assert.equal(finding.evidence.classification, 'unknown');
  assert.match(finding.message, /broadwayscorecard\.com/);

  // A degraded pass rate is its own separate finding.
  assert.ok(s.findings.some((f) => f.code === 'pass-rate-degraded'));
  assert.equal(worstSeverity(s.findings), 'action');
});

test('a single failing message warns rather than pages', () => {
  const s = summarizeReports([report({
    records: [record({ count: 500 }), record({ sourceIp: '198.51.100.7', count: 1, evaluatedDkim: 'fail', evaluatedSpf: 'fail', dkim: [], spf: [] })],
  })]);
  const finding = s.findings.find((f) => f.code === 'unauthenticated-source');
  assert.equal(finding.severity, 'warn');
  // 1 failure in 501 is still above the 99% healthy floor, so no degraded finding.
  assert.equal(s.findings.some((f) => f.code === 'pass-rate-degraded'), false);
});

test('p=none is flagged as unenforced regardless of pass rate', () => {
  const s = summarizeReports([report({ policy: { ...POLICY, p: 'none', sp: 'none' } })]);
  const f = s.findings.find((x) => x.code === 'policy-unenforced');
  assert.ok(f);
  assert.equal(f.severity, 'action');
});

test('policy-upgrade-available needs a clean record, volume AND duration', () => {
  const clean = (days, count) => summarizeReports([
    report({ reportId: 'start', dateBegin: '2026-03-01T00:00:00.000Z', dateEnd: '2026-03-01T23:59:59.000Z', records: [record({ count })] }),
    report({
      reportId: 'end',
      dateBegin: new Date(Date.parse('2026-03-01T00:00:00.000Z') + days * 86400000).toISOString(),
      dateEnd: new Date(Date.parse('2026-03-01T23:59:59.000Z') + days * 86400000).toISOString(),
      records: [record({ count: 1 })],
    }),
  ]);

  const qualifies = clean(170, 12000).findings.find((f) => f.code === 'policy-upgrade-available');
  assert.ok(qualifies, '170 days and 12k clean messages qualifies');
  assert.equal(qualifies.severity, 'info');
  assert.match(qualifies.message, /p=reject/);

  assert.equal(clean(5, 12000).findings.some((f) => f.code === 'policy-upgrade-available'), false, 'too short a window');
  assert.equal(clean(170, 10).findings.some((f) => f.code === 'policy-upgrade-available'), false, 'too little volume');
});

test('policy-upgrade-available never fires while anything is failing', () => {
  const s = summarizeReports([
    report({ reportId: 'a', dateBegin: '2026-03-01T00:00:00.000Z', dateEnd: '2026-03-01T23:59:59.000Z', records: [record({ count: 12000 })] }),
    report({
      reportId: 'b',
      dateBegin: '2026-08-20T00:00:00.000Z',
      dateEnd: '2026-08-20T23:59:59.000Z',
      records: [record({ count: 1, sourceIp: '203.0.113.1', evaluatedDkim: 'fail', evaluatedSpf: 'fail', dkim: [], spf: [] })],
    }),
  ]);
  assert.equal(s.findings.some((f) => f.code === 'policy-upgrade-available'), false);
});

test('already at p=reject produces no upgrade suggestion', () => {
  const s = summarizeReports([
    report({ reportId: 'a', policy: { ...POLICY, p: 'reject' }, dateBegin: '2026-03-01T00:00:00.000Z', dateEnd: '2026-03-01T23:59:59.000Z', records: [record({ count: 12000 })] }),
    report({ reportId: 'b', policy: { ...POLICY, p: 'reject' }, dateBegin: '2026-08-20T00:00:00.000Z', dateEnd: '2026-08-20T23:59:59.000Z', records: [record({ count: 1 })] }),
  ]);
  assert.equal(s.findings.some((f) => f.code === 'policy-upgrade-available'), false);
});

test('stale reports are an actionable finding — silence looks like success', () => {
  const s = summarizeReports([report({ dateEnd: '2026-08-01T23:59:59.000Z' })], { now: '2026-08-20T00:00:00.000Z' });
  const f = s.findings.find((x) => x.code === 'reports-stale');
  assert.ok(f, 'no reports for 19 days means the rua path broke');
  assert.equal(f.severity, 'action');
  assert.equal(f.evidence.staleDays, 18, 'staleDays is rounded to one decimal for the alert body');
});

test('fresh reports produce no staleness finding', () => {
  const s = summarizeReports([report({ dateEnd: '2026-08-20T23:59:59.000Z' })], { now: '2026-08-21T06:00:00.000Z' });
  assert.equal(s.findings.some((f) => f.code === 'reports-stale'), false);
});

test('an empty window is a finding, not a crash', () => {
  const s = summarizeReports([]);
  assert.equal(s.reportCount, 0);
  assert.equal(s.messages.total, 0);
  assert.equal(s.messages.passRate, null, 'no messages means no rate, not 0% or NaN');
  assert.deepEqual(s.findings.map((f) => f.code), ['no-reports']);
  assert.equal(worstSeverity(s.findings), 'action');
});

test('spf-only passes are flagged as forward-fragile', () => {
  const s = summarizeReports([report({ records: [record({ count: 4, evaluatedDkim: 'fail', dkim: [] })] })]);
  const f = s.findings.find((x) => x.code === 'spf-only-passes');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.equal(f.evidence.spfOnly, 4);
});

test('classifySource identifies infrastructure by auth domain, not by IP', () => {
  const base = { pass: 1, fail: 0, dkimSelectors: new Set(), dkimDomains: new Set(), spfDomains: new Set() };
  assert.equal(classifySource({ ...base, spfDomains: new Set(['send.broadwayscorecard.com']) }, 'broadwayscorecard.com'), 'resend');
  assert.equal(classifySource({ ...base, dkimDomains: new Set(['amazonses.com']) }, 'broadwayscorecard.com'), 'resend');
  assert.equal(classifySource({ ...base, dkimSelectors: new Set(['resend']) }, 'broadwayscorecard.com'), 'resend');
  assert.equal(classifySource({ ...base, dkimDomains: new Set(['improvmx.net']) }, 'broadwayscorecard.com'), 'improvmx-forward');
  assert.equal(classifySource({ ...base, pass: 0, fail: 3 }, 'broadwayscorecard.com'), 'unknown');
});

test('buildPolicyTimeline records only changes', () => {
  const t = buildPolicyTimeline([
    report({ dateBegin: '2026-03-13T00:00:00.000Z', policy: { ...POLICY, p: 'none', sp: 'none' } }),
    report({ dateBegin: '2026-03-14T00:00:00.000Z', policy: { ...POLICY, p: 'none', sp: 'none' } }),
    report({ dateBegin: '2026-03-24T00:00:00.000Z', policy: { ...POLICY, p: 'quarantine', sp: 'quarantine' } }),
  ]);
  assert.equal(t.length, 2);
  assert.equal(t[0].p, 'none');
  assert.equal(t[1].p, 'quarantine');
  assert.equal(t[1].observedAt, '2026-03-24T00:00:00.000Z');
});

test('evaluateFindings honours injected thresholds', () => {
  const s = summarizeReports([report({ records: [record({ count: 90 }), record({ sourceIp: '203.0.113.5', count: 10, evaluatedDkim: 'fail', evaluatedSpf: 'fail', dkim: [], spf: [] })] })]);
  // 90% pass: degraded under the default 99% floor, healthy under a 0.5 floor.
  assert.ok(s.findings.some((f) => f.code === 'pass-rate-degraded'));
  const relaxed = evaluateFindings(s, { minPassRateForHealthy: 0.5 });
  assert.equal(relaxed.some((f) => f.code === 'pass-rate-degraded'), false);
});

test('formatSummary renders the headline numbers and every finding', () => {
  const s = summarizeReports([report({ records: [record({ count: 12 })] })]);
  const text = formatSummary(s);
  assert.match(text, /broadwayscorecard\.com/);
  assert.match(text, /p=quarantine/);
  assert.match(text, /12 total, 12 pass, 0 fail/);
  for (const f of s.findings) assert.ok(text.includes(f.code), `finding ${f.code} must appear in the digest`);
});

const NOW = '2026-08-30T12:00:00.000Z';
const summaryFile = (over = {}) => ({
  generatedAt: '2026-08-30T06:00:00.000Z',
  policy: { ...POLICY },
  findings: [],
  lifetime: { messages: 12633, failures: 0, spanDays: 170, reportCount: 233 },
  ...over,
});

test('dmarcHealthResult: clean record passes with the lifetime numbers', () => {
  const r = dmarcHealthResult(summaryFile(), { now: NOW });
  assert.equal(r.status, 'pass');
  assert.match(r.message, /12633 messages, 0 auth failures/);
  assert.match(r.message, /p=quarantine/);
});

test('dmarcHealthResult: a missing summary warns rather than throwing', () => {
  const r = dmarcHealthResult(null, { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /No DMARC summary/);
});

test('dmarcHealthResult: a stale summary warns — the job stopped running', () => {
  const r = dmarcHealthResult(summaryFile({ generatedAt: '2026-08-25T06:00:00.000Z' }), { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /last written \d+h ago/);
});

test('dmarcHealthResult: action findings are an error', () => {
  const r = dmarcHealthResult(summaryFile({
    findings: [{ severity: 'action', code: 'unauthenticated-source', message: '40 messages from 203.0.113.9' }],
  }), { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /unauthenticated-source/);
  assert.match(r.hint, /203\.0\.113\.9/);
});

test('dmarcHealthResult: the upgrade suggestion reaches the digest as a warn', () => {
  // This is the finding that routeAlert never sends, so if it is not surfaced
  // here it is not surfaced anywhere.
  const r = dmarcHealthResult(summaryFile({
    findings: [{ severity: 'info', code: 'policy-upgrade-available', message: 'Zero failures across 12633 messages over 170 days. The domain qualifies for p=reject (currently p=quarantine).' }],
  }), { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /qualifies for p=reject/);
  assert.match(r.hint, /p=reject/);
});

test('dmarcHealthResult: info findings other than the upgrade do not warn', () => {
  const r = dmarcHealthResult(summaryFile({
    findings: [{ severity: 'info', code: 'spf-only-passes', message: '1 message passed on SPF alone' }],
  }), { now: NOW });
  assert.equal(r.status, 'pass');
});

test('worstSeverity ranks action over warn over info', () => {
  assert.equal(worstSeverity([]), 'ok');
  assert.equal(worstSeverity([{ severity: 'info' }]), 'info');
  assert.equal(worstSeverity([{ severity: 'info' }, { severity: 'warn' }]), 'warn');
  assert.equal(worstSeverity([{ severity: 'warn' }, { severity: 'action' }]), 'action');
});
