import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('./silent-dispatch-sweep.js');

const H = 3600000;
const now = Date.parse('2026-11-15T22:00:00Z');
const at = (h) => new Date(now - h * H).toISOString();
const card = (over = {}) => ({ state: { name: 'In Review' }, title: 'x', description: '', labels: { nodes: [] }, ...over });
const disp = (h) => ({ body: 'Dispatched ec4625f7 to linear:BRO-1-abc at 2026-11-15T16:19:39Z (headless)', createdAt: at(h) });

test('silent job: previous claim, then a headless receipt 5h ago, nothing between -> flag; requeue only with the flag and 26h', () => {
  const claim = { body: 'Claimed by local session abc on host at x', createdAt: at(30) };
  const c = [claim, disp(5)];
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: c, nowMs: now }).action, 'flag');
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: c, requeueEnabled: true, nowMs: now }).action, 'flag');
  const old = [claim, disp(27)];
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: old, requeueEnabled: true, nowMs: now }).action, 'requeue');
  assert.equal(S.silentDispatchDecision({ issue: card({ state: { name: 'Todo' } }), comments: old, requeueEnabled: true, nowMs: now }).reason, 'already-todo');
});
test('BRO-7523 shape: the worker report sits BEFORE the receipt, so the card is not called silent (the failed-land note covers it)', () => {
  const c = [{ body: 'Claimed by local session abc on host at x', createdAt: at(8) }, { body: '**Session report (in-review)**', createdAt: at(6) }, disp(5)];
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: c, nowMs: now }).reason, 'report-or-human-activity');
});
test('a cmux dispatch receipt (no "(headless)") is not an anchor', () => {
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [{ body: 'Dispatched ab to workspace:3 at t', createdAt: at(9) }], nowMs: now }).reason, 'no-headless-dispatch');
});
test('landed work is not redone', () => {
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(9)], landedSince: true, nowMs: now }).reason, 'landed-since-dispatch');
});
test('recent dispatch is left alone', () => {
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(1)], nowMs: now }).reason, 'recent-dispatch');
});
test('a person comment, a claim, or a push after the dispatch keeps the card', () => {
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(6), { body: 'looking', createdAt: at(5) }], nowMs: now }).reason, 'report-or-human-activity');
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(6), { body: 'Claimed by https://claude.ai/code/session_x', createdAt: at(5) }], nowMs: now }).reason, 'claimed-after-dispatch');
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(6)], lastPushMs: now - 2 * H, nowMs: now }).reason, 'push-after-dispatch');
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(6)], pushUnknown: true, nowMs: now }).reason, 'push-time-unknown');
});
test('Paused, Done, mac-only, owner and NO-RECLAIM cards are skipped', () => {
  for (const [over, reason] of [
    [{ state: { name: 'Paused' } }, 'state'], [{ state: { name: 'Done' } }, 'state'],
    [{ labels: { nodes: [{ name: 'mac-only' }] } }, 'mac-only'], [{ description: 'MAC-ONLY: needs keychain' }, 'mac-only'],
    [{ title: '\u{1F451} OWNER thing' }, 'owner-card'], [{ description: 'NO-RECLAIM: tracker' }, 'opted-out'],
  ]) assert.equal(S.silentDispatchDecision({ issue: card(over), comments: [disp(9)], nowMs: now }).reason, reason);
});
test('flagging twice is prevented, and repeat silence ends in backlog', () => {
  const flagged = { body: `${S.SILENT_DISPATCH_MARKER} 2026-11-15`, createdAt: at(4) };
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [disp(9), flagged], nowMs: now }).reason, 'already-flagged');
  const earlier = [1, 2].map((i) => ({ body: `RECLAIMED-ABANDONED: d${i}`, createdAt: at(60 + i) }));
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [...earlier, disp(30)], requeueEnabled: true, nowMs: now }).action, 'backlog');
});
test('failed Land run is flagged unless the card names its run id', () => {
  const runs = [{ ref: 'land/job/linear-BRO-7523-x', runId: 43730964480, conclusion: 'failure', url: 'u' }, { ref: 'land/b', runId: 5, conclusion: 'success' }];
  assert.deepEqual(S.unseenFailedLandRuns({ runs, comments: [{ body: 'nothing' }] }).map((r) => r.runId), ['43730964480']);
  assert.deepEqual(S.unseenFailedLandRuns({ runs, comments: [{ body: 'run 43730964480 failed' }] }), []);
  assert.match(S.buildLandFailedComment([{ ref: 'r', runId: '1', url: null }]), /^LAND-FAILED-UNSEEN:/);
});
test('comments carry the markers the reclaim count and dedupe read', () => {
  const d = { action: 'requeue', dispatchAt: 'x', silentHours: 5, priorState: 'In Review', reclaims: 0 };
  assert.ok(S.buildSilentDispatchComment(d, now).startsWith(S.SILENT_DISPATCH_MARKER));
  assert.ok(S.buildSilentRequeueComment(d, now).startsWith('RECLAIMED-ABANDONED:'));
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

test('linear-next refuses a cloud container unless overridden (BRO-7554)', () => {
  const ld = require('./linear-dispatch.js');
  assert.match(ld.cloudDispatchRefusal({ CLAUDE_CODE_REMOTE: 'true' }, 'BRO-9'), /refusing to dispatch BRO-9 from a cloud container/);
  assert.equal(ld.cloudDispatchRefusal({ CLAUDE_CODE_REMOTE: 'true', LINEAR_NEXT_ALLOW_CLOUD: '1' }), null);
  assert.equal(ld.cloudDispatchRefusal({}), null);
  const src = fs.readFileSync(new URL('../linear-next.js', import.meta.url), 'utf8');
  assert.ok(src.includes('ld.cloudDispatchRefusal(process.env, identifier)'), 'linear-next.js must call the refusal before spawning');
  assert.ok(src.indexOf('ld.cloudDispatchRefusal(') < src.lastIndexOf('Mirror-staleness dispatch claim'));
});
test('the sweep mode is registered in the reclaim CLI and the hourly workflow', () => {
  const out = execFileSync('node', [new URL('../linear-reclaim-abandoned.js', import.meta.url).pathname, '--help'], { encoding: 'utf8' });
  assert.match(out, /--silent-dispatch-sweep/);
  const yml = fs.readFileSync(new URL('../../.github/workflows/land-retry-cancelled.yml', import.meta.url), 'utf8');
  assert.match(yml, /linear-reclaim-abandoned\.js --silent-dispatch-sweep/);
  assert.match(yml, /id: silent-dispatch[\s\S]{0,400}continue-on-error: true/);
});
test('worker-pick treats the new notes as machine comments, not answers', () => {
  const src = fs.readFileSync(new URL('./cloud-worker-pick.js', import.meta.url), 'utf8');
  assert.ok(/MACHINE_COMMENT_RE = [^\n]*SILENT-DISPATCH:[^\n]*LAND-FAILED-UNSEEN:/.test(src));
});

test('review fixes: a stall nudge is machine text, and a years-old comment no longer blocks a card with no prior holder', () => {
  const nudge = { body: 'STALL-NUDGE: still working?', createdAt: at(8) };
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [nudge, disp(5)], nowMs: now }).action, 'flag');
  const ancient = { body: 'please look at this', createdAt: at(24 * 90) };
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [ancient, disp(5)], nowMs: now }).action, 'flag');
  const recentHuman = { body: 'please look at this', createdAt: at(20) };
  assert.equal(S.silentDispatchDecision({ issue: card(), comments: [recentHuman, disp(5)], nowMs: now }).reason, 'report-or-human-activity');
  assert.match(S.buildSilentDispatchComment({ dispatchAt: 'x', silentHours: 5, priorState: 'Todo' }, now), /already Todo/);
});
