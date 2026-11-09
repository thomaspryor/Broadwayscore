// BRO-7183: stalled-session sweep decisions. Replays BRO-6947 (background waiters died with the
// container, card left In Progress) and BRO-7074 (ScheduleWakeup never fired, idle 34h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./stalled-session-sweep.js');
const { RECLAIM_MARKER, reclaimDecision } = require('./linear-reclaim-abandoned.js');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const H = 3600 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const SID = 'session_01ABCdef234';
const claim = (at, ref = `https://claude.ai/code/${SID}`) => ({ body: `Claimed by ${ref} at ${at}`, createdAt: at });
const card = (o = {}) => ({
  identifier: 'BRO-6947', title: 'Fix the thing', description: 'VERIFY: node x.js',
  state: { name: 'In Progress', type: 'started' }, updatedAt: ago(22 * H), ...o,
});
const entryFor = (o = {}) => S.stalledSessionEntry({
  issue: card(o.issue), comments: o.comments || [claim(ago(23 * H))], landRefs: o.landRefs || [], nowMs: NOW,
});
const idleSession = (hours, bucket = 'review_ready') => ({ id: SID, status_bucket: bucket, updated_at: ago(hours * H) });

test('BRO-6947 replay: cloud-held card idle 22h with an idle session gets one nudge', () => {
  const e = entryFor();
  assert.equal(e.action, 'check');
  assert.equal(e.sessionId, SID);
  assert.equal(e.idleHours, 22);
  assert.equal(e.nudges, 0);
  const d = S.stalledSessionAction({ entry: e, session: idleSession(22), nowMs: NOW });
  assert.equal(d.action, 'nudge');
  const msg = S.buildStallNudgeMessage(e);
  assert.match(msg, /BRO-6947/);
  assert.match(msg, /Do not reply/);
});

test('BRO-7074 replay: ScheduleWakeup-only session idle 34h is nudged, not left silent', () => {
  const e = entryFor({ issue: { identifier: 'BRO-7074', updatedAt: ago(34 * H) }, comments: [claim(ago(35 * H))] });
  assert.equal(e.action, 'check');
  assert.equal(S.stalledSessionAction({ entry: e, session: idleSession(34, 'completed'), nowMs: NOW }).action, 'nudge');
});

test('the sweep reaches cards at 12h, well before the 48h reclaim', () => {
  const e = entryFor({ issue: { updatedAt: ago(13 * H) }, comments: [claim(ago(13 * H))] });
  assert.equal(e.action, 'check');
  assert.equal(reclaimDecision({ issue: card({ updatedAt: ago(13 * H) }), comments: [], landRefs: [], nowMs: NOW }).reason, 'recent');
  assert.equal(entryFor({ issue: { updatedAt: ago(11 * H) }, comments: [claim(ago(11 * H))] }).reason, 'recent');
});

test('list skips: not In Progress, Mac-held, no claim, owner card, opt-out, blocked report, live land ref', () => {
  assert.equal(entryFor({ issue: { state: { name: 'Paused', type: 'started' } } }).reason, 'not-in-progress');
  assert.equal(entryFor({ issue: { state: { name: 'In Review', type: 'started' } } }).reason, 'not-in-progress');
  assert.equal(entryFor({ comments: [claim(ago(23 * H), 'local session abc on Toms-Mac-Studio.local')] }).reason, 'not-a-cloud-session');
  assert.equal(entryFor({ comments: [{ body: 'just a note', createdAt: ago(23 * H) }] }).reason, 'no-claim');
  assert.equal(entryFor({ issue: { title: '\u{1F451} owner thing' } }).reason, 'owner-card');
  assert.equal(entryFor({ issue: { description: 'NO-RECLAIM: tracker' } }).reason, 'opted-out');
  assert.equal(entryFor({ landRefs: [{ ref: 'land/bro-6947', lastActivityAt: ago(2 * H) }] }).reason, 'live-land-ref');
});

test('working session is left alone; a session on a permission prompt is not messaged', () => {
  const e = entryFor();
  assert.equal(S.stalledSessionAction({ entry: e, session: idleSession(0.1, 'working'), nowMs: NOW }).action, 'skip');
  assert.equal(S.stalledSessionAction({ entry: e, session: idleSession(20, 'blocked'), nowMs: NOW }).action, 'skip');
});

test('archived or missing session: requeue; other get_session errors: retry next firing', () => {
  const e = entryFor();
  assert.equal(S.stalledSessionAction({ entry: e, session: idleSession(22, 'archived'), nowMs: NOW }).action, 'requeue');
  assert.equal(S.stalledSessionAction({ entry: e, error: 'Session not found', nowMs: NOW }).action, 'requeue');
  assert.equal(S.stalledSessionAction({ entry: e, error: 'HTTP 503 upstream', nowMs: NOW }).action, 'skip');
  assert.equal(S.stalledSessionAction({ entry: e, nowMs: NOW }).action, 'skip');
});

test('nudge ledger: one per 24h, requeue after two ignored nudges, a new claim resets it', () => {
  const nudge = (at) => ({ body: `${S.STALL_NUDGE_MARKER} ${at} nudged ${SID}`, createdAt: at });
  const recent = entryFor({ comments: [claim(ago(60 * H)), nudge(ago(13 * H))], issue: { updatedAt: ago(13 * H) } });
  assert.equal(recent.nudges, 1);
  assert.equal(S.stalledSessionAction({ entry: recent, session: idleSession(30), nowMs: NOW }).reason, 'nudged under 24h ago');
  const twice = entryFor({ comments: [claim(ago(80 * H)), nudge(ago(50 * H)), nudge(ago(25 * H))], issue: { updatedAt: ago(25 * H) } });
  assert.equal(twice.nudges, 2);
  assert.equal(S.stalledSessionAction({ entry: twice, session: idleSession(50), nowMs: NOW }).action, 'requeue');
  const reclaimed = entryFor({ comments: [nudge(ago(50 * H)), nudge(ago(40 * H)), { body: `${RECLAIM_MARKER} x`, createdAt: ago(39 * H) }, claim(ago(30 * H))], issue: { updatedAt: ago(25 * H) } });
  assert.equal(reclaimed.nudges, 0);
});

test('requeue comment carries the reclaim marker so MAX_RECLAIMS still sends repeat offenders to Backlog', () => {
  const e = entryFor();
  const body = S.buildStallRequeueComment(e, 'session archived', NOW);
  assert.ok(body.startsWith(RECLAIM_MARKER));
  assert.match(body, /Todo/);
  const twiceReclaimed = entryFor({ comments: [{ body: `${RECLAIM_MARKER} a`, createdAt: ago(200 * H) }, { body: `${RECLAIM_MARKER} b`, createdAt: ago(100 * H) }, claim(ago(23 * H))] });
  assert.equal(twiceReclaimed.requeueTo, 'Backlog');
  assert.match(S.buildStallNudgeComment(e, NOW), /^STALL-NUDGE: /);
});
