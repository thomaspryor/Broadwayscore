// BRO-7553: only the holder's own evidence proves it is alive; a failed landing or a blocked report with no
// follow-up frees the card. Fixtures are frozen shapes of the 2026-11-15 cases (BRO-7523, BRO-7527).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { claimHolderDecision } = require('../../scripts/lib/claim-holder-guard.js');
const { buildOutcomeCommentBody, buildSessionMarker } = require('../../scripts/lib/linear-session-reporting.js');
const { ledgerEvidence } = require('../../scripts/lib/claim-holder-evidence.js');

const NOW = Date.parse('2026-11-15T21:40:00Z');
const H7523 = 'local session 72c5d4b3-1111-4222-8333-444455556666 on Toms-Mac-Studio.local';
const H7527 = 'local session 8bc280f9-1111-4222-8333-444455556666 on Toms-Mac-Studio.local';
const CHILD = 'https://claude.ai/code/session_01CHILDCHILDCHILD';
const iso = (ms) => new Date(ms).toISOString();
const claim = (ref, ms) => ({ body: `Claimed by ${ref} at ${iso(ms)}`, createdAt: iso(ms) });
const parentNote = (ms) => ({ body: 'Takeover: the Mac job stalled after a failed Land run. Restarting it from session_01PARENT.', createdAt: iso(ms) });
const card = (comments, updatedMs) => ({ identifier: 'BRO-7523', title: 't', description: '', updatedAt: iso(updatedMs), state: { name: 'In Progress', type: 'started' }, comments: { nodes: comments } });
const decide = (comments, evidence, selfRef = CHILD) => claimHolderDecision({ issue: card(comments, NOW - 60e3), selfRef, nowMs: NOW, evidence });

test('BRO-7523: failed Land run, no push or comment since, holder is reclaimable despite a parent note', () => {
  const t0 = NOW - 6 * 3600e3;
  const d = decide([claim(H7523, t0), parentNote(NOW - 300e3)], { lastPushMs: t0 + 600e3, landing: { conclusion: 'failure', atMs: t0 + 1800e3 } });
  assert.equal(d.action, 'takeover');
  assert.match(d.reason, /landing failed/);
});

test('BRO-7527 real shape: holder job finished (job-done) 6h ago, card still In Progress, a parent note does not revive it', () => {
  const t0 = NOW - 7 * 3600e3;
  const d = decide([claim(H7527, t0), parentNote(NOW - 300e3)], { lastLedgerMs: t0 + 3600e3, jobEndedMs: t0 + 3600e3 });
  assert.equal(d.action, 'takeover');
  assert.match(d.reason, /job ended/);
  assert.equal(decide([claim(H7527, t0)], { lastLedgerMs: NOW - 600e3, jobEndedMs: t0 + 3600e3 }).action, 'refuse');
});

test('BRO-7527: holder reported blocked, nothing since, a parent note does not revive it', () => {
  const t0 = NOW - 5 * 3600e3;
  const blocked = { body: '**Session report (blocked)**\ncannot do the remaining work', createdAt: iso(t0 + 3600e3) };
  const d = decide([claim(H7527, t0), blocked, parentNote(NOW - 300e3)], null);
  assert.equal(d.action, 'takeover');
  assert.match(d.reason, /blocked/);
});

test('a parent takeover note alone never proves the holder alive: refused before only because of it, now 48h-idle holder is free', () => {
  const t0 = NOW - 49 * 3600e3;
  assert.equal(decide([claim(H7523, t0), parentNote(NOW - 60e3)], null).action, 'takeover');
});

test('a live holder that commented itself within the window still blocks a second claim (BRO-7141)', () => {
  const t0 = NOW - 6 * 3600e3;
  const own = { body: `progress\n\n${buildSessionMarker(H7523)}`, createdAt: iso(NOW - 600e3) };
  const d = decide([claim(H7523, t0), own, parentNote(NOW - 300e3)], { landing: { conclusion: 'failure', atMs: t0 + 1800e3 } });
  assert.equal(d.action, 'refuse');
});

test("another session's marker does not count as the holder's", () => {
  const t0 = NOW - 49 * 3600e3;
  const other = { body: `x\n\n${buildSessionMarker(H7527)}`, createdAt: iso(NOW - 600e3) };
  assert.equal(decide([claim(H7523, t0), other], null).action, 'takeover');
});

test('a push after the failed run keeps the holder live; a failure under 60 minutes old does too', () => {
  const t0 = NOW - 6 * 3600e3;
  assert.equal(decide([claim(H7523, t0)], { lastPushMs: NOW - 600e3, landing: { conclusion: 'failure', atMs: NOW - 7200e3 } }).action, 'refuse');
  assert.equal(decide([claim(H7523, t0)], { landing: { conclusion: 'failure', atMs: NOW - 20 * 60e3 } }).action, 'refuse');
});

test('a successful or missing landing never frees a live holder; no evidence keeps the old conservative behaviour', () => {
  const t0 = NOW - 6 * 3600e3;
  assert.equal(decide([claim(H7523, t0)], { landing: { conclusion: 'success', atMs: NOW - 7200e3 } }).action, 'refuse');
  assert.equal(decide([claim(H7523, t0)], null).action, 'refuse');
});

test('250+ comments (truncated read) stays live', () => {
  const t0 = NOW - 49 * 3600e3;
  const many = Array.from({ length: 250 }, (_, i) => ({ body: `c${i}`, createdAt: iso(t0 + i) }));
  assert.equal(decide([claim(H7523, t0), ...many], null).action, 'refuse');
});

test('session reports carry the poster\'s marker; ledger evidence matches by card or session id', () => {
  assert.match(buildOutcomeCommentBody({ summary: 's', status: 'done', sessionRef: H7523 }), new RegExp(`<!-- session: ${H7523} -->`));
  const rows = [{ taskId: 'linear:BRO-7523', ts: iso(NOW - 1000) }, { taskId: 'linear:BRO-1', sessionId: '72C5D4B3-1111-4222-8333-444455556666', ts: iso(NOW - 500) }];
  assert.equal(ledgerEvidence('BRO-7523', H7523, () => rows).lastLedgerMs, NOW - 500);
  assert.equal(ledgerEvidence('BRO-7523', H7523, () => [{ taskId: 'linear:BRO-7523-x', event: 'job-done', ts: iso(NOW - 900) }]).jobEndedMs, NOW - 900);
  assert.equal(ledgerEvidence('BRO-7523', H7523, () => [{ taskId: 'linear:BRO-7523-x', event: 'job-done', ts: iso(NOW - 900) }, { taskId: 'linear:BRO-7523-x', event: 'job-spawned', ts: iso(NOW - 100) }]).jobEndedMs, null);
});

test('ledger rows of a longer card number (BRO-75230) are not this card\'s', () => {
  assert.equal(ledgerEvidence('BRO-7523', H7523, () => [{ taskId: 'linear:BRO-75230-x', event: 'job-done', ts: iso(NOW - 900) }]).lastLedgerMs, null);
});

test('a blocked report carrying another session\'s marker does not free the holder; cancelled Land runs do not either', () => {
  const t0 = NOW - 5 * 3600e3;
  const foreign = { body: `**Session report (blocked)**\nx\n\n${buildSessionMarker(CHILD)}`, createdAt: iso(t0 + 3600e3) };
  assert.equal(decide([claim(H7523, t0), foreign], null).action, 'refuse');
  assert.equal(decide([claim(H7523, t0)], { landing: { conclusion: 'cancelled', atMs: t0 + 600e3 } }).action, 'refuse');
});

test('claim 48h+ old with a recent push but no marker comment is judged live once the caller supplies the push (idle-takeover re-check)', () => {
  const t0 = NOW - 60 * 3600e3;
  assert.equal(decide([claim(H7523, t0)], null).action, 'takeover');
  assert.equal(decide([claim(H7523, t0)], { lastPushMs: NOW - 600e3 }).action, 'refuse');
});
