/**
 * reclassify-headless-endings.test.mjs — BRO-4066 Gap 2 backfill's pure
 * selection logic: which ledger rows are candidates, and the taskId->ref
 * parse. The I/O-heavy parts (git log search, Linear fetch, spawning
 * ack-landed.js) are exercised live by running the script itself
 * (--dry-run/--apply against the real ledger, per the card). Per CLAUDE.md
 * §15 this require()s the real module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../reclassify-headless-endings.js');

test('refFromTaskId: parses linear:BRO-N and bare BRO-N, rejects anything else', () => {
  assert.equal(mod.refFromTaskId('linear:BRO-3227'), 'BRO-3227');
  assert.equal(mod.refFromTaskId('BRO-42'), 'BRO-42');
  assert.equal(mod.refFromTaskId('notion:1234'), null);
  assert.equal(mod.refFromTaskId(''), null);
});

test('lastRowByJobId: last row per jobId wins, in file order', () => {
  const entries = [
    { jobId: 'J1', event: 'job-spawned' },
    { jobId: 'J2', event: 'job-spawned' },
    { jobId: 'J1', event: 'job-stopped-short' },
    { jobId: 'J1', event: 'landed-acked' },
  ];
  const m = mod.lastRowByJobId(entries);
  assert.equal(m.get('J1'), entries[3]);
  assert.equal(m.get('J2'), entries[1]);
});

const SINCE_MS = Date.parse('2026-09-20T00:00:00.000Z');
const DEFAULT_REASON = 'no THIS SESSION: status line in final result';

test('candidateRows: selects job-stopped-short rows with the default reason at/after the cutoff, unhandled since', () => {
  const entries = [
    // In window, unhandled — a candidate.
    { ts: '2026-09-21T00:00:00.000Z', event: 'job-stopped-short', jobId: 'J1', taskId: 'linear:BRO-1', reason: DEFAULT_REASON },
    // Before the cutoff — excluded.
    { ts: '2026-09-19T00:00:00.000Z', event: 'job-stopped-short', jobId: 'J2', taskId: 'linear:BRO-2', reason: DEFAULT_REASON },
    // Different reason — a genuine (not misclassified) stop, excluded.
    { ts: '2026-09-21T00:00:00.000Z', event: 'job-stopped-short', jobId: 'J3', taskId: 'linear:BRO-3', reason: 'something else' },
    // In window but already handled by a later landed-acked row for the same jobId — excluded.
    { ts: '2026-09-21T00:00:00.000Z', event: 'job-stopped-short', jobId: 'J4', taskId: 'linear:BRO-4', reason: DEFAULT_REASON },
    { ts: '2026-09-21T01:00:00.000Z', event: 'landed-acked', jobId: 'J4', taskId: 'linear:BRO-4' },
  ];
  const lastByJob = mod.lastRowByJobId(entries);
  const out = mod.candidateRows(entries, SINCE_MS, lastByJob);
  assert.deepEqual(out.map((r) => r.jobId), ['J1']);
});

test('hasSessionReportComment: true only for a done/in-review self-reported status, regardless of the card\'s current state', () => {
  const done = { comments: { nodes: [{ body: '**Session report (done)**\n\nfixed it' }] } };
  const paused = { comments: { nodes: [{ body: '**Session report (paused)**\n\nblocked on X' }] } };
  const none = { comments: { nodes: [{ body: 'just a regular comment' }] } };
  assert.equal(mod.hasSessionReportComment(done), true);
  assert.equal(mod.hasSessionReportComment(paused), false);
  assert.equal(mod.hasSessionReportComment(none), false);
  assert.equal(mod.hasSessionReportComment({}), false);
});

test('isDoneOrInReview: reads the card\'s state type/name', () => {
  assert.equal(mod.isDoneOrInReview({ state: { type: 'completed', name: 'Done' } }), true);
  assert.equal(mod.isDoneOrInReview({ state: { type: 'started', name: 'In Review' } }), true);
  assert.equal(mod.isDoneOrInReview({ state: { type: 'unstarted', name: 'Todo' } }), false);
  assert.equal(mod.isDoneOrInReview({}), false);
});
