import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-absence-'));
const ledgerPath = path.join(tmp, 'ledger.json');
process.env.ALERT_LEDGER_PATH = ledgerPath;
process.env.ALERT_DIGEST_QUEUE_PATH = path.join(tmp, 'digest.json');
process.env.ALERT_ATTEMPTS_LOG_PATH = path.join(tmp, 'attempts.jsonl');
const require = createRequire(import.meta.url);
const router = require('../../scripts/lib/owner-alert-router.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nowMs = Date.parse('2026-10-15T12:00:00Z');
const row = (hours, extra = {}) => ({ status: 'open', lastSeen: new Date(nowMs - hours * 3600000).toISOString(), notifyCount: 8, ...extra });
const seed = (conditions) => fs.writeFileSync(ledgerPath, JSON.stringify({ conditions }));

test('each absence family resolves old keys and preserves live keys and the exact boundary', async () => {
  const families = [
    ['scheduled-email-missing:morning-digest:2026-08-04', 48],
    ['health-check:Workflow repeat-failure: Commercial RSS Poll', 96],
    ['cron-health-failed:job', 96], ['cron-health:job', 96],
    ['alert-router:deadman', 96], ['feedback-outcomes:date', 96],
    ['feedback-requests-live:request', 96], ['geo-bots:country', 336],
    ['tier-skip-drift', 336], ['opening-night-remediation-exhausted-empty-cast:show', 168],
    ['on-monitor-launch-failed-on-monitor-2026-07-22', 168],
    ['broadcast-gate:checklist:show', 168], ['broadcast:overdue:show', 168],
    ['land:branch', 168], ['direct-push:sha', 168],
    ['gap:show/file.json', 336], ['backstop:show/file.json', 336],
    ...['orphan-unscored-requeue', 'review-gap', 'roundup-gap',
      'we-aggregator-go-live', 'ob-venue-go-live', 'express-retry-still-thin',
      'slug-misroute', 'outlet-ground-truth'].map((prefix) => [`${prefix}:show/file.json`, 168]),
  ];
  for (const [key, hours] of families) {
    const old = row(hours + 1);
    seed({ [key]: old, 'unknown:old': row(1000) });
    assert.deepEqual(await router.resolveAbsentConditions({ nowMs }), [key], key);
    assert.deepEqual(router.loadLedger().conditions[key], {
      ...old, status: 'resolved', resolvedAt: new Date(nowMs).toISOString(), resolveReason: 'absent',
    });
    for (const age of [1, hours]) {
      seed({ [key]: row(age) });
      assert.deepEqual(await router.resolveAbsentConditions({ nowMs }), [], `${key} at ${age}h is live`);
      assert.equal(router.loadLedger().conditions[key].status, 'open');
    }
  }
});

test('weekly geo and tier-skip alerts seen seven days ago stay open', async () => {
  const conditions = { 'geo-bots:Iran': row(168), 'tier-skip-drift': row(168) };
  seed(conditions);
  assert.deepEqual(await router.resolveAbsentConditions({ nowMs }), []);
  assert.deepEqual(router.loadLedger().conditions, conditions);
});

test('performance budgets follow normal quieting while provider budgets stay protected', async () => {
  const key = 'health-check:Workflow repeat-failure: Check Performance Budget';
  assert.equal(router.isNeverQuietCondition(key), false);
  assert.equal(router.decideDigestEscalation({
    conditionKey: key,
    existing: { linearIdentifier: 'BRO-1', lastSurfacedAt: new Date(nowMs).toISOString() },
    notifyCount: 30, now: nowMs,
  }).action, 'quiet');
  seed({ [key]: row(97), 'health-check:Provider budget': row(1000) });
  assert.deepEqual(await router.resolveAbsentConditions({ nowMs }), [key]);
  assert.equal(router.loadLedger().conditions['health-check:Provider budget'].status, 'open');
});

test('paid usage, unknown families, durable integrity alerts and malformed dates stay open', async () => {
  const keys = ['provider-spend:overspend', 'bd-circuit-breaker-web_unlocker2',
    'health-check:Provider budget', 'opening-night-spend:show', 'future-family:show',
    'push-ledger-revert:main:sha', 'alert-sender-direct-bypass'];
  const conditions = Object.fromEntries(keys.map((key) => [key, row(1000)]));
  conditions['backstop:bad-date'] = row(1000, { lastSeen: 'invalid' });
  conditions['backstop:missing-date'] = row(1000, { lastSeen: undefined });
  conditions['backstop:closed'] = row(1000, { status: 'resolved' });
  seed(conditions);
  const before = fs.readFileSync(ledgerPath, 'utf8');
  assert.deepEqual(await router.resolveAbsentConditions({ nowMs }), []);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before);
});

test('tracked absence resolves only Done, follows duplicates, and caches shared tracker reads', async () => {
  const states = ['completed', 'started', 'unstarted', 'backlog', 'canceled', 'missing', 'error', 'duplicate', 'cycle'];
  seed(Object.fromEntries(states.map((state) => [`backstop:${state}`, row(1000, { linearIdentifier: state })])));
  router.patchCondition('backstop:completed', { title: 'Keep history' });
  const counts = {};
  const getIssueFn = async (id) => {
    counts[id] = (counts[id] || 0) + 1;
    if (id === 'error') throw new Error('offline');
    if (id === 'missing') return null;
    if (id === 'duplicate' || id === 'cycle') return {
      state: { type: 'duplicate' }, relations: { nodes: [{ type: 'duplicate', relatedIssue: { identifier: id === 'duplicate' ? 'completed' : 'cycle' } }] },
    };
    return { state: { type: id } };
  };
  const resolved = await router.resolveAbsentConditions({ nowMs, getIssueFn });
  assert.deepEqual(resolved.sort(), ['backstop:completed', 'backstop:duplicate']);
  assert.equal(router.loadLedger().conditions['backstop:completed'].linearIdentifier, 'completed');
  assert.equal(router.loadLedger().conditions['backstop:completed'].title, 'Keep history');
  for (const state of states.filter((s) => !['completed', 'duplicate'].includes(s))) {
    assert.equal(router.loadLedger().conditions[`backstop:${state}`].status, 'open', state);
  }
  seed({ 'backstop:a': row(1000, { linearIdentifier: 'completed' }), 'backstop:b': row(1000, { linearIdentifier: 'completed' }) });
  counts.completed = 0;
  assert.equal((await router.resolveAbsentConditions({ nowMs, getIssueFn })).length, 2);
  assert.equal(counts.completed, 1);
  assert.deepEqual(await router.resolveAbsentConditions({ nowMs, getIssueFn }), [], 'idempotent');
});

test('a condition refreshed while checking Linear stays open', async () => {
  seed({ 'backstop:show': row(1000, { linearIdentifier: 'BRO-1' }) });
  const getIssueFn = async () => {
    router.patchCondition('backstop:show', { lastSeen: new Date(nowMs).toISOString() });
    return { state: { type: 'completed' } };
  };
  assert.deepEqual(await router.resolveAbsentConditions({ nowMs, getIssueFn }), []);
});

test('daily CI health check calls the sweep after refreshing conditions', () => {
  const source = fs.readFileSync(new URL('../../scripts/health-check.js', import.meta.url), 'utf8');
  const sweep = source.indexOf('await resolveAbsentConditions()');
  assert.ok(sweep > source.indexOf('await sendEmailDigest(allResults'));
  assert.ok(sweep > source.indexOf('if (!isCI) {\n    console.log(\'ℹ️'));
});
