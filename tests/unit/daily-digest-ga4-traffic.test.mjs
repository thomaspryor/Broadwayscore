import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2502-'));
const previousQueuePath = process.env.ALERT_DIGEST_QUEUE_PATH;
process.env.ALERT_DIGEST_QUEUE_PATH = path.join(tmp, 'queue.json');
after(() => {
  if (previousQueuePath === undefined) delete process.env.ALERT_DIGEST_QUEUE_PATH;
  else process.env.ALERT_DIGEST_QUEUE_PATH = previousQueuePath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { fetchAndQueueTrafficSummary } = require('../../scripts/lib/daily-digest-ga4-traffic.js');
const { peekDigestQueue, toSnapshotQueuedRow } = require('../../scripts/lib/owner-alert-router.js');
const { planAutofix, runAutofix, keepDecisionQueued } = require('../../scripts/lib/digest-autofix.js');
const { composeDigestEmail } = require('../../scripts/send-morning-digest.js');
const now = new Date('2026-10-19T09:00:00Z');

function clientFor(rows) {
  return { runReport: async (request) => {
    assert.deepEqual(request.dateRanges, [{ startDate: '7daysAgo', endDate: 'yesterday' }]);
    assert.equal(request.property, 'properties/123');
    assert.deepEqual(request.metrics, [{ name: 'sessions' }, { name: 'engagedSessions' }]);
    return [{ rows }];
  } };
}

const channel = (name, sessions, engaged) => ({
  dimensionValues: [{ value: name }],
  metricValues: [{ value: String(sessions) }, { value: String(engaged) }],
});

test('weekly KPI reaches the actual morning email as information, never an autofix', async () => {
  // BRO-44 channel example, through the real GA4 response parser and queue.
  const summary = await fetchAndQueueTrafficSummary(clientFor([
    channel('Direct', 25000, 1500),
    channel('Organic Search', 5000, 3200),
    channel('Referral', 2168, 980),
  ]), '123', now);
  assert.equal(summary.headline, 5680);
  assert.equal(summary.totalSessions, 32168);
  const health = { generatedAt: now.toISOString(), errors: [], warns: [], queued: peekDigestQueue().map(toSnapshotQueuedRow) };
  assert.equal(health.queued.length, 1);
  assert.equal(health.queued[0].info, true);
  assert.equal(health.queued[0].decision, false);
  const plan = planAutofix({ health, tasks: [], queued: health.queued, today: '2026-10-19' });
  assert.deepEqual(plan.map(r => r.state), ['info']);
  const autofixRows = runAutofix({ plan, dryRun: false, log: () => {},
    ledgerPath: path.join(tmp, 'autofix.jsonl'),
    dispatchFn: () => assert.fail('Traffic must never dispatch a fix'),
  });
  health.queued = keepDecisionQueued(health.queued, autofixRows);
  for (const rows of [autofixRows, null]) {
    const { html, subject } = composeDigestEmail({ sections: { health }, autofixRows: rows, now, dispatchSecret: 'test-only' });
    assert.match(html, /Traffic \(7d\): 5,680 engaged sessions/);
    assert.match(html, /5\.7x raw-session inflation \(32,168 raw sessions\)/);
    assert.match(html, /Weekly update 2026-10-19/);
    assert.doesNotMatch(html, /Dispatch a fix/);
    assert.doesNotMatch(subject, /decision/);
  }
});

test('no Direct channel is still included; a rerun replaces only the traffic entry', async () => {
  const unrelated = { conditionKey: 'other', title: 'Another receipt', info: true };
  fs.writeFileSync(process.env.ALERT_DIGEST_QUEUE_PATH, JSON.stringify([...peekDigestQueue(), unrelated]));
  await fetchAndQueueTrafficSummary(clientFor([channel('Organic Search', 120, 100)]), '123', now);
  const queued = peekDigestQueue();
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.find(q => q.conditionKey === 'other'), unrelated);
  assert.match(queued.find(q => q.conditionKey !== 'other').title, /100 engaged sessions; 1\.2x/);
});

test('zero engaged sessions and empty reports show n/a inflation, never Infinity', async () => {
  for (const rows of [[channel('Direct', 1000, 0)], []]) {
    await fetchAndQueueTrafficSummary(clientFor(rows), '123', now);
    const row = peekDigestQueue().find(q => q.conditionKey === 'traffic:ga4-engaged-sessions');
    assert.match(row.title, /0 engaged sessions; n\/a raw-session inflation/);
    assert.doesNotMatch(row.title, /Infinity|NaN/);
  }
});

test('a failed GA4 fetch does not queue invented zero traffic or overwrite a prior report', async () => {
  const before = peekDigestQueue();
  await assert.rejects(fetchAndQueueTrafficSummary({ runReport: async () => { throw new Error('GA4 unavailable'); } }, '123', now), /GA4 unavailable/);
  assert.deepEqual(peekDigestQueue(), before);
});

test('existing weekly cron calls the producer and persists its existing queue', () => {
  const audit = fs.readFileSync(new URL('../../scripts/audit-geo-bots.js', import.meta.url), 'utf8');
  const workflow = fs.readFileSync(new URL('../../.github/workflows/weekly-geo-audit.yml', import.meta.url), 'utf8');
  assert.match(audit, /require\('\.\/lib\/daily-digest-ga4-traffic'\)/);
  assert.match(audit, /await fetchAndQueueTrafficSummary\(client, propertyId\)/);
  assert.match(workflow, /node scripts\/audit-geo-bots\.js/);
  assert.match(workflow, /git add data\/audit\/alert-digest-queue\.json/);
});
