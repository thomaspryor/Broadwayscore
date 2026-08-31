// scripts/tests/dmarc-ingest.test.mjs
//
// Tests the ingest script's pure functions (CLAUDE.md rule 15 — require()d
// from the real module, not restated).
//
// stripForPersistence is the privacy boundary: this repo is PUBLIC and
// Microsoft's aggregate reports carry <envelope_to>, the recipient's domain.
// If that ever reaches data/audit/, subscriber and press-contact domains are
// published in git history. That is why it has a test of its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, stripForPersistence, filterByDomain } = require('../ingest-dmarc-reports.js');

const reportWith = (domain, records = []) => ({
  orgName: 'Outlook.com',
  orgEmail: 'dmarcreport@microsoft.com',
  reportId: 'abc',
  dateBegin: '2026-08-01T00:00:00.000Z',
  dateEnd: '2026-08-01T23:59:59.000Z',
  policy: { domain, adkim: 'r', aspf: 'r', p: 'quarantine', sp: 'quarantine', np: '', pct: 100 },
  messageCount: records.reduce((n, r) => n + r.count, 0),
  records,
});

const rec = (over = {}) => ({
  sourceIp: '54.240.9.36',
  count: 4,
  disposition: 'none',
  evaluatedDkim: 'pass',
  evaluatedSpf: 'pass',
  overrides: [],
  headerFrom: 'broadwayscorecard.com',
  envelopeFrom: 'bounces@send.broadwayscorecard.com',
  envelopeTo: 'dianekrausz.com',
  dkim: [{ domain: 'broadwayscorecard.com', result: 'pass', selector: 'resend' }],
  spf: [{ domain: 'send.broadwayscorecard.com', result: 'pass', scope: 'mfrom' }],
  ...over,
});

test('parseArgs: defaults', () => {
  const a = parseArgs(['node', 'script']);
  assert.equal(a.days, 30);
  assert.equal(a.out, 'data/audit');
  assert.equal(a.domain, 'broadwayscorecard.com');
  assert.equal(a.dryRun, false);
  assert.equal(a.alert, false);
  assert.equal(a.fromDir, null);
});

test('parseArgs: flags', () => {
  const a = parseArgs(['node', 's', '--dry-run', '--alert', '--quiet', '--days=7', '--out=/tmp/x', '--from-dir=/tmp/in', '--domain=Example.COM']);
  assert.equal(a.dryRun, true);
  assert.equal(a.alert, true);
  assert.equal(a.quiet, true);
  assert.equal(a.days, 7);
  assert.equal(a.out, '/tmp/x');
  assert.equal(a.fromDir, '/tmp/in');
  assert.equal(a.domain, 'example.com', 'domain is lowercased to match parsed report domains');
});

test('parseArgs: --backfill widens the window', () => {
  const a = parseArgs(['node', 's', '--backfill']);
  assert.equal(a.backfill, true);
  assert.equal(a.days, 400);
});

test('stripForPersistence: never persists recipient data', () => {
  const row = stripForPersistence(reportWith('broadwayscorecard.com', [rec(), rec({ envelopeTo: 'ritzcarlton.com' })]));
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes('dianekrausz'), false);
  assert.equal(serialized.includes('ritzcarlton'), false);
  assert.equal(serialized.includes('envelopeTo'), false);
  // Nor the raw records, which are what carries envelopeTo.
  assert.equal(row.records, undefined);
});

test('stripForPersistence: keeps the fields the ledger is for', () => {
  const row = stripForPersistence(reportWith('broadwayscorecard.com', [rec({ count: 6 }), rec({ count: 4 })]));
  assert.equal(row.orgName, 'Outlook.com');
  assert.equal(row.reportId, 'abc');
  assert.equal(row.dateBegin, '2026-08-01T00:00:00.000Z');
  assert.equal(row.messageCount, 10);
  assert.equal(row.recordCount, 2);
  assert.equal(row.failCount, 0);
  assert.equal(row.policy.p, 'quarantine');
  assert.match(row.ingestedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('stripForPersistence: failCount counts only records failing BOTH identifiers', () => {
  const row = stripForPersistence(reportWith('broadwayscorecard.com', [
    rec({ count: 5 }),
    rec({ count: 3, evaluatedSpf: 'fail' }),                        // forwarded: DKIM saves it
    rec({ count: 7, evaluatedDkim: 'fail', evaluatedSpf: 'fail' }), // genuine failure
  ]));
  assert.equal(row.messageCount, 15);
  assert.equal(row.failCount, 7);
});

test('filterByDomain: drops reports for other domains', () => {
  const reports = [reportWith('broadwayscorecard.com'), reportWith('someoneelse.com')];
  const kept = filterByDomain(reports, 'broadwayscorecard.com');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].policy.domain, 'broadwayscorecard.com');
});

test('filterByDomain: "all" and empty keep everything', () => {
  const reports = [reportWith('a.com'), reportWith('b.com')];
  assert.equal(filterByDomain(reports, 'all').length, 2);
  assert.equal(filterByDomain(reports, '').length, 2);
});
