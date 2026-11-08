// BRO-7130: each failing Data Validation step gets its own alert with its own
// title, is resolved when that step passes, and long failures feed escalation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  stepConditionKey, advisoryStepNames, planDataValidationRouting, alertForStep, routeDataValidationRun,
  LEGACY_KEY, UNLISTED_KEY, ESCALATION_HOURS, DEFER_FILING_HOURS,
} = require('./data-validation-routing.js');

const YML = fs.readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
const open = (extra = {}) => ({ status: 'open', ...extra });
const MARKET = 'Validate market expansion';
const ARCHIVE = 'Validate archive productions';

test('advisory steps come from the live workflow (step-level continue-on-error)', () => {
  const adv = advisoryStepNames(YML);
  assert.ok(adv.has(ARCHIVE), 'archive audit is advisory');
  assert.ok(!adv.has(MARKET), 'market expansion is a blocking step of the job');
});

test('the live workflow still has the steps this routing names', () => {
  assert.match(YML, new RegExp(`- name: ${MARKET}\\n`));
  assert.match(YML, /- name: Route data-audit failures to the daily digest\n[\s\S]{0,2500}routeDataValidationRun/);
});

test('each failing step is routed under its own key and title', () => {
  const steps = [{ name: MARKET, conclusion: 'failure' }, { name: 'Validate data', conclusion: 'failure' }, { name: 'Other', conclusion: 'success' }];
  const plan = planDataValidationRouting({ steps, advisory: new Set(), ledgerConditions: {} });
  assert.deepEqual(plan.route, [MARKET, 'Validate data']);
  assert.notEqual(stepConditionKey(MARKET), stepConditionKey('Validate data'));
  const a = alertForStep(MARKET, { runUrl: 'https://x/runs/1', ymlText: YML });
  assert.equal(a.conditionKey, 'test-yml:data-validation-red:validate-market-expansion');
  assert.equal(a.title, `Data audit failing: ${MARKET}`);
  assert.equal(a.disposition, 'auto');
  assert.equal(a.deferFilingHours, DEFER_FILING_HOURS);
  assert.match(a.verify.line, /^VERIFY: node scripts\/validate-market-expansion\.js/);
});

test('an advisory step failing is never routed, and its old key is resolved', () => {
  const steps = [{ name: ARCHIVE, conclusion: 'failure' }, { name: MARKET, conclusion: 'success' }];
  const plan = planDataValidationRouting({ steps, advisory: new Set([ARCHIVE]), ledgerConditions: { [stepConditionKey(ARCHIVE)]: open() } });
  assert.deepEqual(plan.route, []);
  assert.deepEqual(plan.resolve.map((r) => r.key), [stepConditionKey(ARCHIVE)]);
});

test('resolve on pass or removal; a skipped step keeps its alert open', () => {
  const ledgerConditions = {
    [stepConditionKey(MARKET)]: open(),
    [stepConditionKey('Skipped audit')]: open(),
    [stepConditionKey('Renamed away')]: open(),
    [stepConditionKey('Still failing')]: open(),
    [LEGACY_KEY]: open(),
    'other-key': open(),
  };
  const steps = [
    { name: MARKET, conclusion: 'success' },
    { name: 'Skipped audit', conclusion: 'skipped' },
    { name: 'Still failing', conclusion: 'failure' },
  ];
  const plan = planDataValidationRouting({ steps, advisory: new Set(), ledgerConditions });
  assert.deepEqual(plan.route, ['Still failing']);
  assert.deepEqual(plan.resolve.map((r) => r.key).sort(), [LEGACY_KEY, stepConditionKey(MARKET), stepConditionKey('Renamed away')].sort());
});

test('step lookup failed: nothing per-step resolves, legacy key still retires', () => {
  const plan = planDataValidationRouting({ steps: null, ledgerConditions: { [stepConditionKey(MARKET)]: open(), [LEGACY_KEY]: open() } });
  assert.deepEqual(plan.route, []);
  assert.deepEqual(plan.resolve.map((r) => r.key), [LEGACY_KEY]);
});

function fakeRouter(conditions = {}) {
  const calls = { routed: [], resolved: [] };
  return {
    calls,
    loadLedger: () => ({ conditions }),
    resolveCondition: (key, { reason }) => { calls.resolved.push([key, reason]); return true; },
    routeAlert: async (opts) => { calls.routed.push(opts); return { action: 'digest' }; },
  };
}

test('runner routes failing steps and hands them to escalation at the 48h threshold', async () => {
  const router = fakeRouter({ [LEGACY_KEY]: open() });
  let escalated;
  const out = await routeDataValidationRun(
    { steps: [{ name: MARKET, conclusion: 'failure' }], ymlText: YML, runUrl: 'u', jobStatus: 'success' },
    { router, escalate: async (keys, opts) => { escalated = { keys, opts }; } },
  );
  assert.deepEqual(router.calls.routed.map((o) => o.conditionKey), [stepConditionKey(MARKET)]);
  assert.deepEqual(router.calls.resolved.map(([k]) => k), [LEGACY_KEY]);
  assert.deepEqual(escalated.keys, [stepConditionKey(MARKET)]);
  assert.equal(escalated.opts.thresholdHours, ESCALATION_HOURS);
  assert.doesNotMatch(escalated.opts.subject, /main has been red/);
  assert.deepEqual(out.routed, [stepConditionKey(MARKET)]);
});

test('runner: unreadable step list on a failing job queues one fallback digest line, never the legacy key', async () => {
  const router = fakeRouter({});
  await routeDataValidationRun({ steps: null, ymlText: YML, runUrl: 'u', jobStatus: 'failure' }, { router, escalate: async () => {} });
  assert.deepEqual(router.calls.routed.map((o) => [o.conditionKey, o.disposition]), [[UNLISTED_KEY, 'digest']]);
});

test('runner: a green run routes nothing and escalates nothing', async () => {
  const router = fakeRouter({});
  let escalated;
  await routeDataValidationRun({ steps: [{ name: MARKET, conclusion: 'success' }], ymlText: YML, runUrl: 'u', jobStatus: 'success' },
    { router, escalate: async (keys) => { escalated = keys; } });
  assert.deepEqual(router.calls.routed, []);
  assert.deepEqual(escalated, []);
});

test('the market-expansion VERIFY command stays read-only (its safe-form entry depends on it)', () => {
  const { scanReadOnly } = require('../audit-safe-form-allowlist.js');
  const r = scanReadOnly('scripts/validate-market-expansion.js');
  assert.equal(r.clean, true, JSON.stringify(r.hazards));
});
