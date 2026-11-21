import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCodexIssues, assessCodexForStatusFile, codexLineFromStatus } = require('./lib/codex-status-line.js');

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const DAY = 1440;

const open = (identifier) => ({ identifier, delegateName: 'Codex' });
const withSession = (identifier, ageMin, isOpen = true) => ({
  identifier, delegateName: 'Codex', open: isOpen,
  sessions: [{ createdAt: ago(ageMin), status: 'active', activities: [{ createdAt: ago(ageMin - 1), body: 'Reading the code structure.' }] }],
});

test('BRO-256 signature: open Codex issues with no session read disconnected', () => {
  const r = assessCodexForStatusFile([], [open('BRO-256'), open('BRO-260')], { nowMs: NOW });
  assert.equal(r.status, 'disconnected');
});

test('flips to connected once a real Codex delegation produces session activity', () => {
  const before = assessCodexForStatusFile([], [open('BRO-256')], { nowMs: NOW });
  const after = assessCodexForStatusFile([withSession('BRO-256', 10)], [open('BRO-256')], { nowMs: NOW });
  assert.equal(before.status, 'disconnected');
  assert.equal(after.status, 'connected');
});

test('a finished, now-closed Codex run still counts as connected evidence', () => {
  const closed = withSession('BRO-300', 2 * DAY, false);
  closed.sessions[0].status = 'complete';
  assert.equal(assessCodexForStatusFile([closed], [], { nowMs: NOW }).status, 'connected');
});

test('old successes outside the rolling window do not mask a new outage', () => {
  const old = withSession('BRO-100', 60 * DAY, false);
  const r = assessCodexForStatusFile([old], [open('BRO-256')], { nowMs: NOW });
  assert.equal(r.status, 'disconnected');
  assert.equal(buildCodexIssues([old], [], NOW).length, 0);
});

test('non-Codex delegates are ignored', () => {
  const cyrus = { identifier: 'BRO-1', delegateName: 'cyrus', open: true, sessions: [] };
  assert.equal(assessCodexForStatusFile([cyrus], [{ identifier: 'BRO-1', delegateName: 'cyrus' }], { nowMs: NOW }).status, 'unknown');
});

test('truncated session list reports unknown, never a false disconnected', () => {
  assert.equal(assessCodexForStatusFile([], [open('BRO-256')], { truncated: true, nowMs: NOW }).status, 'unknown');
});

test('digest line: distinct text per state, nothing when stale, missing or unknown', () => {
  const fresh = (codex) => ({ at: ago(30), codex });
  assert.match(codexLineFromStatus(fresh({ status: 'disconnected' }), NOW), /^Codex: disconnected \(matches BRO-256\)/);
  assert.match(codexLineFromStatus(fresh({ status: 'connected' }), NOW), /^Codex: connected/);
  assert.equal(codexLineFromStatus(fresh({ status: 'unknown' }), NOW), null);
  assert.equal(codexLineFromStatus({ at: ago(30) }, NOW), null, 'file from before this field existed');
  assert.equal(codexLineFromStatus({ at: ago(5 * 60), codex: { status: 'connected' } }, NOW), null, 'stale file');
  assert.equal(codexLineFromStatus({ codex: { status: 'connected' } }, NOW), null, 'no timestamp');
});

test('check-linear-delegations.js can be required without running or exiting', () => {
  require('./check-linear-delegations.js');
});

const stuck = (identifier, updatedMinAgo) => ({ identifier, delegateName: 'Codex', updatedAt: ago(updatedMinAgo) });

test('open Codex issue whose only sessions are older than the window is not "never started"', () => {
  const r = assessCodexForStatusFile([withSession('BRO-100', 8 * DAY, true)], [open('BRO-100')], { nowMs: NOW });
  assert.equal(r.status, 'unknown');
});

test('a delegation made seconds ago is not evidence of an outage', () => {
  assert.equal(assessCodexForStatusFile([], [stuck('BRO-900', 1)], { nowMs: NOW }).status, 'unknown');
});

test('one earlier success does not hide a newer delegation that never started', () => {
  const r = assessCodexForStatusFile([withSession('BRO-300', 3 * DAY, false)], [stuck('BRO-256', 60)], { nowMs: NOW });
  assert.equal(r.status, 'disconnected');
});

test('a recent success newer than any stuck delegation stays connected', () => {
  const r = assessCodexForStatusFile([withSession('BRO-300', 10, true)], [stuck('BRO-256', 2 * DAY)], { nowMs: NOW });
  assert.equal(r.status, 'connected');
});

test('a session that completed with no work still proves the request reached the agent', () => {
  const s = withSession('BRO-301', 60, true);
  s.sessions[0].status = 'complete';
  s.sessions[0].activities = [];
  assert.equal(assessCodexForStatusFile([s], [], { nowMs: NOW }).status, 'connected');
});

test('digest line ignores a status timestamp in the future', () => {
  assert.equal(codexLineFromStatus({ at: new Date(NOW + 3600000).toISOString(), codex: { status: 'connected' } }, NOW), null);
});
