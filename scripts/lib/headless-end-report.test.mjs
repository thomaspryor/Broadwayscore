import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const her = require('./headless-end-report.js');
const lsr = require('./linear-session-reporting.js');

const T0 = Date.parse('2026-10-23T10:00:00Z');
const report = (status, iso, extra = '') => ({ body: lsr.buildOutcomeCommentBody({ summary: 'x' + extra, status }), createdAt: iso });

test('worker report after job start counts; older report and own fallback do not', () => {
  assert.equal(her.hasReportSince({ comments: { nodes: [report('paused', '2026-10-23T10:30:00Z')] } }, T0), true);
  assert.equal(her.hasReportSince({ comments: { nodes: [report('paused', '2026-10-22T10:30:00Z')] } }, T0), false);
  assert.equal(her.hasReportSince({ comments: { nodes: [{ body: 'Dispatched abc to x', createdAt: '2026-10-23T10:30:00Z' }] } }, T0), false);
  assert.equal(her.hasReportSince({ comments: [report('blocked', '2026-10-23T10:30:00Z', her.MARKER)] }, T0), false);
});

test('classifyEnd names killed, failed and runner outcomes', () => {
  assert.equal(her.classifyEnd({ ok: false, stage: 'timeout' }), 'killed-timeout');
  assert.equal(her.classifyEnd({ ok: false, stage: 'spawn' }), 'failed-spawn');
  assert.equal(her.classifyEnd({ ok: true, headlessOutcome: 'stopped-short' }), 'stopped-short');
  assert.equal(her.classifyEnd({ ok: true, headlessOutcome: 'done' }), 'done');
});

test('fallback report is a blocked session report with no owner-hold wording', async () => {
  const posted = [];
  const client = { getIssue: async () => ({ comments: { nodes: [] } }), createComment: async (id, body) => posted.push([id, body]) };
  const res = { ok: true, headlessOutcome: 'stopped-short', endReason: 'no THIS SESSION: status line in final result', jobId: 'j1', logFile: '/tmp/l' };
  assert.equal(await her.postEndReportIfMissing({ id: 'I1', identifier: 'BRO-1' }, res, T0, client), 'posted');
  assert.equal(posted.length, 1);
  assert.equal(lsr.parseSessionReportStatus(posted[0][1]), 'blocked');
  assert.match(posted[0][1], /stopped-short/);
  const { pausedHistorySkipReason } = require('./cloud-worker-pick.js');
  assert.equal(pausedHistorySkipReason([{ body: posted[0][1], createdAt: new Date().toISOString() }], Date.now() + 60 * 3600_000), null);
});

test('no duplicate when the worker already reported; API errors never throw', async () => {
  const posted = [];
  const reported = { getIssue: async () => ({ comments: { nodes: [report('in-review', '2026-10-23T10:30:00Z')] } }), createComment: async () => posted.push(1) };
  assert.equal(await her.postEndReportIfMissing({ id: 'I1', identifier: 'BRO-1' }, { ok: true }, T0, reported), 'worker-reported');
  assert.equal(posted.length, 0);
  const broken = { getIssue: async () => { throw new Error('down'); }, createComment: async () => {} };
  assert.equal(await her.postEndReportIfMissing({ id: 'I1', identifier: 'BRO-1' }, { ok: false, stage: 'timeout' }, T0, broken), 'error');
});
