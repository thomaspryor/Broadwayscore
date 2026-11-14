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

test('review fixes: only a structured or session-named not-found requeues; Backlog text matches the picker', () => {
  const e = entryFor();
  assert.equal(S.stalledSessionAction({ entry: e, error: 'HTTP 404 Not Found', nowMs: NOW }).action, 'skip');
  assert.equal(S.stalledSessionAction({ entry: e, error: 'tool get_session not found', nowMs: NOW }).action, 'skip');
  assert.equal(S.stalledSessionAction({ entry: e, error: 'whatever', notFound: true, nowMs: NOW }).action, 'requeue');
  assert.equal(S.stalledSessionAction({ entry: e, error: 'Session session_01ABC does not exist', nowMs: NOW }).action, 'requeue');
  const { RECLAIM_TO_BACKLOG_RE, isMachineComment } = require('./cloud-worker-pick.js');
  const back = { ...e, requeueTo: 'Backlog', reclaims: 2 };
  assert.match(S.buildStallRequeueComment(back, 'x', NOW), RECLAIM_TO_BACKLOG_RE);
  assert.equal(isMachineComment(S.buildStallNudgeComment(e, NOW)), true);
});

// BRO-7195: Mac-held cards. The 2026-11-09 board had 8 of 9 stale In Progress cards claimed as
// "Claimed by local session <uuid> on Toms-Mac-Studio.local at ..."; the cloud sweep skipped all 8.
const LSID = '37ba01ba-7659-47b4-9c28-ec96e16caf42';
const localClaim = (at, host = 'Toms-Mac-Studio.local') => ({ body: `Claimed by local session ${LSID} on ${host} at ${at}.`, createdAt: at });
const localEntry = (o = {}) => S.stalledSessionEntry({
  issue: card({ identifier: 'BRO-7006', ...(o.issue || {}) }), comments: o.comments || [localClaim(ago(41 * H))], landRefs: [], nowMs: NOW, local: true,
});
const view = (o = {}) => ({ hostNames: ['Toms-Mac-Studio.local', 'Toms-Mac-Studio'], liveIds: new Set(), psText: '', transcriptMtimeMs: NOW - 40 * H, lastLedgerMs: NOW - 41 * H, nowMs: NOW, ...o });

test('BRO-7195 replay: a Mac-held card whose session is gone (40h quiet, no ledger row in 24h) is requeued', () => {
  const e = localEntry();
  assert.equal(e.action, 'check-local');
  assert.equal(e.sessionId, LSID);
  assert.equal(e.host, 'Toms-Mac-Studio.local');
  const d = S.localStallAction({ entry: e, ...view() });
  assert.equal(d.action, 'requeue');
  assert.match(S.buildStallRequeueComment(e, d.reason, NOW), new RegExp(`^${RECLAIM_MARKER}`));
});

test('BRO-7195: the cloud sweep still skips local claims, and a local entry is never a cloud check', () => {
  assert.equal(entryFor({ comments: [localClaim(ago(41 * H))] }).reason, 'not-a-cloud-session');
  assert.equal(S.stalledSessionAction({ entry: localEntry(), session: idleSession(40), nowMs: NOW }).action, 'skip');
  assert.equal(localEntry({ comments: [claim(ago(23 * H))] }).reason, 'not-a-local-session');
  assert.equal(localEntry({ comments: [{ body: `Claimed by a session on Toms-Mac-Studio.local at ${ago(41 * H)}`, createdAt: ago(41 * H) }] }).reason, 'not-a-local-session');
});

test('BRO-7195: a Mac-held card is left alone when anything says the session may still be working', () => {
  const e = localEntry();
  const skip = (o) => S.localStallAction({ entry: e, ...view(o) });
  assert.match(skip({ liveIds: new Set([LSID]) }).reason, /still running/);
  assert.match(skip({ psText: `claude --resume ${LSID} --print` }).reason, /running process/);
  assert.match(skip({ lastLedgerMs: NOW - 25 * H }).reason, /dispatch ledger/); // bsc-reconcile may still resume it (24h + margin)
  assert.match(skip({ liveCwds: ['/Users/x/Broadwayscore/.claude/worktrees/job-linear-BRO-7006-mvzz'] }).reason, /worktree/);
  assert.equal(skip({ liveCwds: ['/Users/x/Broadwayscore/.claude/worktrees/job-linear-BRO-70061-a'] }).action, 'requeue');
  assert.match(skip({ transcriptMtimeMs: NOW - 2 * H }).reason, /recently/);
  assert.match(skip({ transcriptMtimeMs: null }).reason, /no transcript/);
  assert.match(skip({ liveIds: null }).reason, /registry unreadable/);
  assert.match(skip({ hostNames: ['Toms-MacBook-Air'] }).reason, /another machine/);
  // LocalHostName (no .local) still matches the claim's hostname.
  assert.equal(skip({ hostNames: ['Toms-Mac-Studio'] }).action, 'requeue');
});

test('BRO-7195: the reclaim exclusions still apply to local claims (owner card, NO-RECLAIM)', () => {
  assert.equal(localEntry({ issue: { description: 'NO-RECLAIM: long soak' } }).action, 'skip');
});
