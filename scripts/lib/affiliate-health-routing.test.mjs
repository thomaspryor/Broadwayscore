// BRO-8220: end-to-end routing for the affiliate monitor's provider checks,
// through the REAL owner-alert-router with email (sendAlert) and Linear
// stubbed and every ledger/queue path in a temp dir.
//
// The incident: an Impact HTTP 503 (2026-11-22) emailed the owner
// "Re-authorize the Impact API credentials". The fix splits provider-auth
// (pages) from provider-fetch (digest only) onto separate condition keys,
// because the router mutes repeats by key alone: a shared key would let a
// day-1 outage note silence a day-2 real revocation page for the cooldown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadWithFakes() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-routing-test-'));
  process.env.ALERT_LEDGER_PATH = path.join(tmp, 'ledger.json');
  // Pre-create it: with no file, loadLedger() seeds from the live tracked
  // ledger, which would make this test depend on bot-committed data.
  fs.writeFileSync(process.env.ALERT_LEDGER_PATH, JSON.stringify({ conditions: {} }));
  process.env.ALERT_DIGEST_QUEUE_PATH = path.join(tmp, 'alert-digest-queue.json');
  process.env.ALERT_ATTEMPTS_LOG_PATH = path.join(tmp, 'alert-router-attempts.jsonl');
  process.env.START_NOW_ROUTER_DISABLED = 'true';
  delete process.env.GITHUB_ACTIONS;
  delete process.env.CI;
  const sent = [];
  const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('./discord-notify.js', { sendAlert: async (opts) => { sent.push(opts); return true; } });
  stub('./linear-issue-create.js', {
    createLinearIssue: async (opts) => ({ issue: { id: 'x', identifier: 'BRO-999', title: opts.title }, mode: 'park' }),
    isUsageLimitExceeded: () => false,
  });
  stub('./linear-client.js', {
    searchIssues: async () => null,
    getTeam: async () => ({ id: 't', states: [] }),
    getIssue: async (id) => ({ identifier: id, state: { type: 'unstarted' } }),
    TEAM_KEY: 'BRO',
    graphql: async () => ({}),
  });
  for (const rel of ['./owner-alert-router.js', '../check-affiliate-health.js']) delete require.cache[require.resolve(rel)];
  const mod = require('../check-affiliate-health.js');
  const ledger = () => {
    const l = JSON.parse(fs.readFileSync(process.env.ALERT_LEDGER_PATH, 'utf8'));
    return l.conditions || l;
  };
  return { ...mod, sent, ledger };
}

const POSTHOG = [{ date: '2026-11-22', clicks: 300, ttClicks: 200 }];
const providerChecks = (runChecks, errors) =>
  runChecks({ impactDaily: [], posthogDaily: POSTHOG, actions: [], errors, asOf: '2026-11-22' })
    .filter((c) => c.key.startsWith('affiliate:provider'));

test('REAL 2026-11-22 503: digest only, no email; a real 401 the next run still emails', async () => {
  const { runChecks, routeResults, sent, ledger } = loadWithFakes();

  // Day 1: the 2026-11-22 outage.
  await routeResults(providerChecks(runChecks, [{ provider: 'impact', message: 'Impact performance-by-day error: HTTP 503' }]), { asOf: '2026-11-22', shadow: false });
  assert.equal(sent.length, 0, 'an outage must not email the owner');
  assert.equal(ledger()['affiliate:provider-fetch:impact'].disposition, 'digest');

  // Day 2: credentials really revoked. Must page despite day 1's open outage.
  await routeResults(providerChecks(runChecks, [{ provider: 'impact', message: 'Impact performance-by-day error: HTTP 401' }]), { asOf: '2026-11-23', shadow: false });
  assert.equal(sent.length, 1, 'a real revocation must email even right after an outage');
  assert.equal(ledger()['affiliate:provider-auth:impact'].status, 'open');
});

test('an auth incident left open by the old single-key code resolves once a later run proves the login works', async () => {
  const { runChecks, routeResults, sent, ledger } = loadWithFakes();
  // Old code paged the 503 on the auth key: seed that open incident.
  await routeResults([{ key: 'affiliate:provider-auth:impact', label: 'impact API', verdict: 'critical', reason: 'impact fetch failed: HTTP 503', wantsPage: true }], { asOf: '2026-11-22', shadow: false });
  assert.equal(ledger()['affiliate:provider-auth:impact'].status, 'open');
  const emailsBefore = sent.length;
  // Next run: the report endpoint still 503s but the Actions endpoint (same login) succeeds.
  await routeResults(providerChecks(runChecks, [{ provider: 'impact', message: 'Impact performance-by-day error: HTTP 503' }]), { asOf: '2026-11-23', shadow: false });
  assert.equal(ledger()['affiliate:provider-auth:impact'].status, 'resolved');
  assert.equal(ledger()['affiliate:provider-fetch:impact'].disposition, 'digest');
  assert.equal(sent.length, emailsBefore, 'no new email for the outage');
});
