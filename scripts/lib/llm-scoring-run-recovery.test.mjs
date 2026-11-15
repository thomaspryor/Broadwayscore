import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { reportRollingCostAlerts, reportRunCostBreach, COST_BREACH_CONDITION_KEY: key } = require('./llm-scoring-cost-recording.js');
const now = new Date('2026-11-15T03:00:00Z');
const run = (overrides = {}) => ({
  runId: 'healthy', completedAt: '2026-11-15T02:00:00Z', costUsd: 1,
  source: 'index', processed: 10, tokensUsed: { input: 1000 }, ...overrides,
});
const expired = run({ runId: 'old-breach', completedAt: '2026-11-13T06:42:00Z', costUsd: 9.05 });

async function check(runs, options = {}) {
  const resolved = [], alerts = [];
  await reportRollingCostAlerts(runs, {
    now, thresholdUsd: 100, runThresholdUsd: 6,
    resolveCondition: (conditionKey, details) => resolved.push({ conditionKey, ...details }),
    routeAlert: alert => alerts.push(alert), ...options,
  });
  return { resolved: resolved.filter(r => r.conditionKey === key), alerts };
}

test('a full healthy window clears the per-run incident, summing invocations at the $6 boundary', async () => {
  const runs = [expired, run({ costUsd: 4 }), run({ costUsd: 2, source: 'comparative-rescore' }),
    run({ runId: 'other', costUsd: 5, processed: 11 })];
  const { resolved, alerts } = await check(runs);
  assert.equal(resolved.length, 1);
  assert.match(resolved[0].reason, /24h/);
  assert.match(resolved[0].reason, /\$6\.00/);
  assert.equal(alerts.length, 0);
});

test('a cheap invocation cannot clear another recent run or its own cumulative breach', async () => {
  const cases = [
    [expired, run({ runId: 'expensive', costUsd: 6.01 }), run()],
    [expired, run({ costUsd: 4 }), run({ costUsd: 2.01, source: 'comparative-rescore' })],
    // An invocation outside the window still counts toward a run active inside it.
    [expired, run({ completedAt: '2026-11-14T02:59:59Z', costUsd: 6 }), run()],
    [expired, run({ completedAt: '2026-11-14T03:00:00Z', costUsd: 6.01 }), run({ runId: 'other' })],
  ];
  for (const runs of cases) assert.equal((await check(runs)).resolved.length, 0);
});

test('recovery requires complete, finite evidence and a full window; dry runs never resolve', async () => {
  const cases = [
    { runs: [] }, { runs: [expired] }, { runs: [run()] },
    { runs: [expired, run()], dryRun: true },
    ...[null, NaN, Infinity, 0, -1].map(runThresholdUsd => ({ runs: [expired, run()], runThresholdUsd })),
    ...[null, '', undefined, 123].map(runId => ({ runs: [expired, run({ runId })] })),
    ...[undefined, null, '1', NaN, Infinity, -1].map(costUsd => ({ runs: [expired, run(), run({ costUsd })] })),
    ...[null, {}, run({ completedAt: 'invalid' }), run({ completedAt: '2026-11-16T00:00:00Z' })]
      .map(bad => ({ runs: [expired, run(), bad] })),
    { runs: [expired, run()], now: new Date(NaN) },
    { runs: [expired, run({ completedAt: '2026-11-14T02:00:00Z', costUsd: undefined }), run()] },
  ];
  for (const { runs, ...options } of cases) {
    assert.equal((await check(runs, options)).resolved.length, 0, JSON.stringify({ runs, ...options }));
  }
  const legacy = { ...expired, costUsd: undefined };
  assert.equal((await check([legacy, run({ costUsd: 0 })])).resolved.length, 1,
    'expired unknown costs on an unrelated run do not block current evidence');
});

test('per-run recovery is independent of daily overspend and repeat alerts', async () => {
  const { resolved, alerts } = await check([expired,
    run({ runId: 'a', costUsd: 4 }), run({ runId: 'b', costUsd: 4 }), run({ runId: 'c', costUsd: 4 }),
  ], { thresholdUsd: 10 });
  assert.equal(resolved.length, 1);
  assert.deepEqual(alerts.map(a => a.conditionKey), ['llm-scoring:daily-cost-breach', 'llm-scoring:cost-repeat-signature']);
});

test('resolution failures stay non-fatal and later breaches still route immediately', async () => {
  let attempts = 0;
  const { alerts } = await check([expired, run(), run(), run()], {
    resolveCondition: conditionKey => {
      if (conditionKey === key) { attempts++; throw new Error('ledger unavailable'); }
    },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(alerts.map(a => a.conditionKey), ['llm-scoring:cost-repeat-signature']);
  const routed = [];
  const result = await reportRunCostBreach([run({ costUsd: 6.01 })], {
    runId: 'healthy', thresholdUsd: 6, routeAlert: a => routed.push(a),
  });
  assert.equal(result.breached, true);
  assert.equal(routed[0].conditionKey, key);
});

test('the existing reporting path persists recovery through the real router, preserving other incidents', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-run-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'ledger.json');
  const incident = { status: 'open', lastSeen: expired.completedAt, linearIdentifier: 'BRO-7395', notifyCount: 16 };
  const unrelated = { ...incident, linearIdentifier: 'BRO-other' };
  fs.writeFileSync(ledgerPath, JSON.stringify({ conditions: { [key]: incident, 'unrelated:cost-breach': unrelated } }));
  const result = spawnSync(process.execPath, ['-e', `
    const { reportRollingCostAlerts } = require('./scripts/lib/llm-scoring-cost-recording');
    reportRollingCostAlerts(JSON.parse(process.env.TEST_RUNS), {
      now: new Date('${now.toISOString()}'),
      routeAlert: () => { throw new Error('healthy spend must not route'); },
    }).catch(() => { process.exitCode = 1; });
  `], {
    cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ALERT_LEDGER_PATH: ledgerPath, TEST_RUNS: JSON.stringify([expired, run()]) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).conditions;
  assert.equal(saved[key].status, 'resolved');
  assert.ok(Number.isFinite(Date.parse(saved[key].resolvedAt)));
  assert.equal(saved[key].lastSeen, incident.lastSeen);
  assert.equal(saved[key].linearIdentifier, incident.linearIdentifier);
  assert.equal(saved[key].notifyCount, incident.notifyCount);
  assert.deepEqual(saved['unrelated:cost-breach'], unrelated);
});
