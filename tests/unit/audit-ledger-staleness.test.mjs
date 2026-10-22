import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { progressLedgerAlert, recordProgress, PROGRESS_LEDGER_MAX_AGE_HOURS } = require('../../scripts/lib/progress-watch');
const { AUDIT_FRESHNESS_CHECKS, evaluateAuditFreshness, auditFreshnessPlaybookEntries } = require('../../scripts/lib/audit-freshness-checks');
const { commercialHistoryIssue, computeCommercialModelDriftStatus } = require('../../scripts/lib/commercial-model-drift');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const H = 3600000;
const iso = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();
const state = (hours = [48, 24]) => ({
  lastRunAt: iso(hours.at(-1)),
  surfaces: { queue: { history: hours.map((age) => ({ ts: iso(age), value: 0 })) } },
});

test('daily observations are healthy even for an empty queue; input is unchanged', () => {
  const prior = state();
  const copy = structuredClone(prior);
  assert.equal(progressLedgerAlert(prior, NOW), null);
  assert.deepEqual(prior, copy);
});

test('the three-day tolerance includes its boundary and alerts immediately beyond it', () => {
  assert.equal(PROGRESS_LEDGER_MAX_AGE_HOURS, 72);
  assert.equal(progressLedgerAlert(state([72]), NOW), null);
  assert.match(progressLedgerAlert(state([72.01]), NOW).description, /last persisted run/);
});

test('missing, corrupt, and empty persisted state cannot silently reset history', () => {
  for (const prior of [null, {}, { lastRunAt: iso(1), surfaces: {} },
    { lastRunAt: iso(1), surfaces: { queue: { history: [] } } },
    { ...state(), lastRunAt: 'not a date' },
    { ...state(), surfaces: { queue: { history: [{ ts: 'bad' }] } } }]) {
    assert.ok(progressLedgerAlert(prior, NOW));
  }
});

test('future timestamps cannot make a broken ledger healthy; one-hour skew is allowed', () => {
  assert.equal(progressLedgerAlert(state([-0.5]), NOW), null);
  assert.match(progressLedgerAlert(state([-2]), NOW).description, /invalid/);
  const prior = state([-2]);
  prior.lastRunAt = iso(1);
  assert.match(progressLedgerAlert(prior, NOW).description, /invalid observation/);
});

test('a fresh lastRunAt cannot hide stale observations', () => {
  const prior = state([96]);
  prior.lastRunAt = iso(1);
  assert.match(progressLedgerAlert(prior, NOW).description, /latest persisted observation/);
});

test('resumed writes cannot hide a recent continuity gap; old gaps age out', () => {
  assert.match(progressLedgerAlert(state([144, 48, 24]), NOW).description, /96.0h gap/);
  assert.equal(progressLedgerAlert(state([360, 192, 144, 120, 96, 72, 48, 24]), NOW), null);
});

test('continuity sorts observations and checks every surface', () => {
  const prior = state([24, 48]);
  prior.lastRunAt = iso(24);
  assert.equal(progressLedgerAlert(prior, NOW), null);
  prior.surfaces.second = state([144, 48, 24]).surfaces.queue;
  assert.match(progressLedgerAlert(prior, NOW).description, /second: 96.0h gap/);
});

test('the pre-write alert survives adding a fresh observation', () => {
  const prior = state([96]);
  const alert = progressLedgerAlert(prior, NOW);
  prior.lastRunAt = iso(0);
  prior.surfaces.queue.history = recordProgress(prior.surfaces.queue.history, 0, { ts: iso(0) });
  assert.match(alert.description, /last persisted run was 96.0h/);
  assert.match(progressLedgerAlert(prior, NOW).description, /96.0h gap/);
});

test('the actual writer persists a pre-write finding for the credentialed health router', () => {
  const { decideProgress } = require('../../scripts/check-progress-stalls');
  const row = AUDIT_FRESHNESS_CHECKS.find((r) => r.file === 'progress-watch-state.json');
  const result = decideProgress({ needsRescoreUnblocked: 0 }, {}, NOW);
  const written = { ...result.state, lastRunAt: iso(0) };
  assert.ok(written.priorLedgerAlert);
  assert.equal(evaluateAuditFreshness(row, written, NOW).status, 'warn');
  assert.match(evaluateAuditFreshness(row, written, NOW).message, /no persisted surfaces/);
  const recovered = decideProgress({ needsRescoreUnblocked: 0 }, written, NOW + 24 * H);
  assert.equal(recovered.state.priorLedgerAlert, null);
  assert.equal(evaluateAuditFreshness(row, { ...recovered.state, lastRunAt: iso(-24) }, NOW + 24 * H).status, 'ok');
});

test('the independent health row detects a stopped writer without launching paid scoring', () => {
  const row = AUDIT_FRESHNESS_CHECKS.find((r) => r.file === 'progress-watch-state.json');
  assert.ok(row);
  assert.equal(row.field, 'lastRunAt');
  assert.equal(row.warnH, PROGRESS_LEDGER_MAX_AGE_HOURS);
  assert.equal(evaluateAuditFreshness(row, state([24]), NOW).status, 'ok');
  assert.equal(evaluateAuditFreshness(row, state([96]), NOW).status, 'warn');
  assert.equal(evaluateAuditFreshness(row, state([144]), NOW).status, 'error');
  assert.equal(evaluateAuditFreshness(row, null, NOW).status, 'error');
  const playbook = auditFreshnessPlaybookEntries().find((e) => e.match.test('Freshness: audit/progress-watch-state.json'));
  assert.ok(playbook.humanAction);
  assert.equal(playbook.workflow, undefined);
});

test('commercial weekly history tolerates 200h but cannot report healthy indefinitely', () => {
  const history = [{ date: iso(200), aiEstimatedCount: 10 }];
  assert.equal(commercialHistoryIssue(history, NOW), null);
  assert.equal(computeCommercialModelDriftStatus(history, NOW).status, 'pass');
  history[0].date = iso(201);
  assert.match(commercialHistoryIssue(history, NOW), /201.0h old/);
  assert.equal(computeCommercialModelDriftStatus(history, NOW).status, 'warn');
});

test('commercial writer recovery leaves a missed week visible to the digest', () => {
  const history = [{ date: iso(336), aiEstimatedCount: 10 }];
  assert.ok(commercialHistoryIssue(history, NOW));
  history.push({ date: iso(0), aiEstimatedCount: 10 });
  assert.match(computeCommercialModelDriftStatus(history, NOW).message, /336.0h gap/);
  // A normal following week clears the continuity issue without modifying
  // or backfilling historical records.
  history.push({ date: iso(-168), aiEstimatedCount: 10 });
  assert.equal(computeCommercialModelDriftStatus(history, NOW + 168 * H).status, 'pass');
});

test('commercial history rejects missing, invalid, future and reversed dates', () => {
  for (const history of [[], [{}], [{ date: 'bad' }], [{ date: iso(-2) }],
    [{ date: 'bad' }, { date: iso(1) }], [{ date: iso(1) }, { date: iso(2) }]]) {
    assert.ok(commercialHistoryIssue(history, NOW));
  }
});

test('commercial freshness warnings reach the existing health-check router selector', () => {
  const { selectUnroutedVisitorRows } = require('../../scripts/lib/start-now-filing');
  const row = { name: 'Commercial model drift', ...computeCommercialModelDriftStatus([{ date: iso(336) }], NOW) };
  assert.deepEqual(selectUnroutedVisitorRows([row]), [row]);
});
