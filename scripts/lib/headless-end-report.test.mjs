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
  assert.equal(her.hasReportSince({ comments: [{ body: her.MARKER + ' (stopped-short).', createdAt: '2026-10-23T10:30:00Z' }] }, T0), false);
});

test('classifyEnd names killed, failed and runner outcomes', () => {
  assert.equal(her.classifyEnd({ ok: false, stage: 'timeout' }), 'killed-timeout');
  assert.equal(her.classifyEnd({ ok: false, stage: 'spawn' }), 'failed-spawn');
  assert.equal(her.classifyEnd({ ok: true, headlessOutcome: 'stopped-short' }), 'stopped-short');
  assert.equal(her.classifyEnd({ ok: true, headlessOutcome: 'done' }), 'done');
});

test('fallback is a machine comment, not a session report, with no owner-hold wording', async () => {
  const posted = [];
  const client = { getIssue: async () => ({ comments: { nodes: [] } }), createComment: async (id, body) => posted.push([id, body]) };
  const res = { ok: true, headlessOutcome: 'stopped-short', endReason: 'no THIS SESSION: status line in final result', jobId: 'j1', logFile: '/tmp/l' };
  assert.equal(await her.postEndReportIfMissing({ id: 'I1', identifier: 'BRO-1' }, res, T0, client), 'posted');
  assert.equal(posted.length, 1);
  assert.equal(lsr.parseSessionReportStatus(posted[0][1]), null); // sweeps must not read it as the worker's report
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

test('sweeps treat the fallback as machine text, not a report or an owner answer (BRO-6092 review)', () => {
  const body = her.buildEndSummary({ ok: true, headlessOutcome: 'stranded', jobId: 'j' });
  const { classifyZombieComment } = require('./linear-started-zombie-sweep-verify.js');
  assert.equal(classifyZombieComment(body), 'machine');
  const { isHolderOrReclaimComment } = require('./linear-reclaim-abandoned.js');
  if (isHolderOrReclaimComment) assert.equal(isHolderOrReclaimComment({ body }), true);
});

test('clean exit that already closed the card, and worktree-error, post nothing', async () => {
  const posted = [];
  const done = { getIssue: async () => ({ state: { type: 'completed' }, comments: { nodes: [] } }), createComment: async () => posted.push(1) };
  assert.equal(await her.postEndReportIfMissing({ id: 'I', identifier: 'BRO-1' }, { ok: true, headlessOutcome: 'done' }, T0, done), 'worker-reported');
  assert.equal(await her.postEndReportIfMissing({ id: 'I', identifier: 'BRO-1' }, { ok: false, stage: 'worktree-error' }, T0, done), 'skipped');
  assert.equal(posted.length, 0);
});

test('one note per job, and a quoted marker in a real report is not machine text (Codex review)', async () => {
  const posted = [];
  const res = { ok: true, headlessOutcome: 'stranded', jobId: 'job-9', endReason: 'VERIFY: x DECISION NEEDED' };
  const body = her.buildEndSummary(res);
  assert.doesNotMatch(body, /VERIFY:|DECISION NEEDED/);
  const client = { getIssue: async () => ({ comments: { nodes: [{ body, createdAt: '2026-10-23T10:31:00Z' }] } }), createComment: async () => posted.push(1) };
  assert.equal(await her.postEndReportIfMissing({ id: 'I', identifier: 'BRO-1' }, res, T0, client), 'worker-reported');
  assert.equal(posted.length, 0);
  // ok-but-not-done with the card closed by someone else still gets its note.
  const closed = { getIssue: async () => ({ state: { type: 'completed' }, comments: { nodes: [] } }), createComment: async () => posted.push(1) };
  assert.equal(await her.postEndReportIfMissing({ id: 'I', identifier: 'BRO-1' }, { ok: true, headlessOutcome: 'stopped-short' }, T0, closed), 'posted');
});

test('cloud-worker-pick treats the fallback as machine text (guards the hardcoded regex against marker drift)', () => {
  const { pausedHistorySkipReason } = require('./cloud-worker-pick.js');
  const now = Date.now();
  const held = { body: lsr.buildOutcomeCommentBody({ summary: 'Not landed: needs an owner decision on the prod flip.', status: 'paused' }), createdAt: new Date(now - 10 * 864e5).toISOString() };
  const note = { body: her.buildEndSummary({ ok: false, stage: 'timeout', jobId: 'j' }), createdAt: new Date(now - 1000).toISOString() };
  assert.equal(pausedHistorySkipReason([held, note], now), 'awaiting-owner');
});
