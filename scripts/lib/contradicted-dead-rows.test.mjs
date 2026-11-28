// BRO-2648: requires the real attribution function the live dispatch gate and
// audit-false-dead-ledger-rows.js share (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyDeadRowsForTask, contradictedDeadKeysForTask, isAutomationReport } = require('./contradicted-dead-rows.js');
const { buildOutcomeCommentBody } = require('./linear-session-reporting.js');
const { ZOMBIE_RESET_MARKER } = require('./linear-started-zombie-sweep.js');
const { WATCHDOG_SAFETY_NET_PREFIX } = require('./dispatch-watchdog-core.js');
const { deadDispatchGuard } = require('./dispatch-guards.js');

const T = 'linear:BRO-9';
const report = (createdAt, summary = 'did the work') => ({
  createdAt, body: buildOutcomeCommentBody({ status: 'in-review', summary }),
});
const dead = (ref, ts) => ({ event: 'dead', taskId: T, workspaceRef: ref, ts });
const launch = (ref, ts) => ({ event: 'launch', taskId: T, workspaceRef: ref, ts });

test('real report after the death, no successor → contradicted key', () => {
  const rows = [launch('workspace:1', '2026-08-31T00:43:00Z'), dead('workspace:1', '2026-08-31T00:55:00Z')];
  const keys = contradictedDeadKeysForTask(T, rows, [report('2026-08-31T01:31:00Z')]);
  assert.deepEqual([...keys], ['workspace:1|2026-08-31T00:55:00Z']);
});

test('report BEFORE the death → no key', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z')];
  assert.equal(contradictedDeadKeysForTask(T, rows, [report('2026-08-31T00:50:00Z')]).size, 0);
});

test('report after a later ledger launch → ambiguous, no key', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z'), launch('workspace:2', '2026-08-31T01:00:00Z')];
  const { contradicted, ambiguous } = classifyDeadRowsForTask(T, rows, [report('2026-08-31T01:31:00Z')]);
  assert.equal(contradicted.length, 0);
  assert.equal(ambiguous.length, 1);
});

test('a "Dispatched ..." comment between death and report (no ledger launch, e.g. other machine) → ambiguous', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z')];
  const comments = [
    report('2026-08-31T01:31:00Z'),
    { createdAt: '2026-08-31T01:00:00Z', body: 'Dispatched abcd1234 to workspace:9 at 2026-08-31T01:00:00Z (cmux)' },
  ];
  const { contradicted, ambiguous } = classifyDeadRowsForTask(T, rows, comments);
  assert.equal(contradicted.length, 0);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].nextDispatchCommentAt, '2026-08-31T01:00:00Z');
});

test('automation reports (zombie sweep, watchdog park) are skipped; the real report after them is attributed', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z')];
  const comments = [
    report('2026-08-31T01:00:00Z', `${ZOMBIE_RESET_MARKER}: BRO-9's most recent dispatch ...`),
    report('2026-08-31T01:05:00Z', `${WATCHDOG_SAFETY_NET_PREFIX} headless job j1 ended ...`),
    report('2026-08-31T01:31:00Z'),
  ];
  const { contradicted } = classifyDeadRowsForTask(T, rows, comments);
  assert.equal(contradicted.length, 1);
  assert.equal(contradicted[0].reportedAt, '2026-08-31T01:31:00Z');
  assert.equal(isAutomationReport(comments[0].body), true);
  assert.equal(isAutomationReport(comments[2].body), false);
});

test('only automation reports → no key', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z')];
  const comments = [report('2026-08-31T01:00:00Z', `${ZOMBIE_RESET_MARKER}: reset`)];
  assert.equal(contradictedDeadKeysForTask(T, rows, comments).size, 0);
});

test('non-report comments never contradict', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z')];
  assert.equal(contradictedDeadKeysForTask(T, rows, [{ createdAt: '2026-08-31T01:31:00Z', body: 'looks done to me' }]).size, 0);
});

test('comments supplied newest-first are sorted before attribution', () => {
  const rows = [dead('workspace:1', '2026-08-31T00:55:00Z')];
  const comments = [
    report('2026-08-31T03:00:00Z'),
    { createdAt: '2026-08-31T02:00:00Z', body: 'Dispatched abcd1234 to workspace:9 at t (cmux)' },
    report('2026-08-31T01:31:00Z'),
  ];
  const { contradicted } = classifyDeadRowsForTask(T, rows, comments);
  assert.equal(contradicted.length, 1);
  assert.equal(contradicted[0].reportedAt, '2026-08-31T01:31:00Z');
});

test('other tasks\' dead rows are ignored', () => {
  const rows = [{ event: 'dead', taskId: 'linear:BRO-10', workspaceRef: 'workspace:1', ts: '2026-08-31T00:55:00Z' }];
  assert.equal(contradictedDeadKeysForTask(T, rows, [report('2026-08-31T01:31:00Z')]).size, 0);
});

// The live gate: deadDispatchGuard refuses at the cap without keys and passes
// once the contradicted row is discounted.
test('deadDispatchGuard: contradicted dead rows no longer count toward the cap (BRO-2648)', () => {
  const rows = [
    launch('workspace:1', '2026-08-31T00:00:00Z'), dead('workspace:1', '2026-08-31T00:30:00Z'),
    launch('workspace:2', '2026-08-31T02:00:00Z'), dead('workspace:2', '2026-08-31T02:30:00Z'),
  ];
  const task = { id: T };
  assert.match(deadDispatchGuard(task, rows, {}) || '', /has died 2x/);
  const keys = contradictedDeadKeysForTask(T, rows, [report('2026-08-31T02:45:00Z')]);
  assert.equal(keys.size, 1);
  assert.equal(deadDispatchGuard(task, rows, { contradictedDeadKeys: keys }), null);
  assert.equal(deadDispatchGuard(task, rows, { contradictedDeadKeys: new Set() }) !== null, true);
});
