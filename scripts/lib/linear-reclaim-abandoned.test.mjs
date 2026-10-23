import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RECLAIM_IDLE_MS, LIVE_LAND_REF_MS, MAX_RECLAIMS, COMMENT_CAP, RECLAIM_MARKER,
  DISPATCH_BLOCKED_WINDOW_MS, isDispatchTimeBlocked,
  reclaimListSkipReason, findReclaimCandidates, reclaimDecision, buildReclaimComment,
} = require('./linear-reclaim-abandoned.js');
const { AUTOFIX_FILED_MARKER } = require('./autofix-filed-marker.js');
const { buildOutcomeCommentBody } = require('./linear-session-reporting.js');

const NOW = Date.parse('2026-10-11T12:00:00Z');
const H = 3600 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const card = (o = {}) => ({
  identifier: 'BRO-100', title: 'Fix the thing', description: 'VERIFY: node x.js',
  state: { name: 'In Progress', type: 'started' }, updatedAt: ago(RECLAIM_IDLE_MS + H), ...o,
});
const decide = (o = {}) => reclaimDecision({ issue: card(o.issue), comments: o.comments || [], landRefs: o.landRefs || [], nowMs: NOW });

test('idle started card with no land ref goes back to Todo', () => {
  const d = decide();
  assert.equal(d.action, 'todo');
  assert.equal(d.reclaims, 0);
  assert.deepEqual(d.staleRefs, []);
  assert.equal(d.idleHours, RECLAIM_IDLE_MS / H + 1);
});

test('recently updated card is kept', () => {
  assert.deepEqual(decide({ issue: { updatedAt: ago(RECLAIM_IDLE_MS - H) } }), { action: 'skip', reason: 'recent' });
});

test('autofix-filed In Review, unstarted, owner and opted-out cards are kept', () => {
  assert.equal(decide({ issue: { state: { name: 'In Review', type: 'started' }, description: `x\n${AUTOFIX_FILED_MARKER}` } }).reason, 'in-review');
  assert.equal(decide({ issue: { state: { name: 'Todo', type: 'unstarted' } } }).reason, 'not-started');
  assert.equal(decide({ issue: { state: { name: 'Backlog', type: 'backlog' } } }).reason, 'not-started');
  assert.equal(decide({ issue: { title: '\u{1F451} OWNER — Fleet cost audit' } }).reason, 'owner-card');
  assert.equal(decide({ issue: { title: 'OWNER: pick a vendor' } }).reason, 'owner-card');
  assert.equal(decide({ issue: { title: 'Owner-alert router drops rows' } }).action, 'todo');
  assert.equal(decide({ issue: { description: 'Tracker.\n\nNO-RECLAIM: umbrella card' } }).reason, 'opted-out');
  assert.equal(decide({ issue: { updatedAt: 'garbage' } }).reason, 'no-updated-at');
});

test('a live land ref keeps the card; an abandoned one does not and is named', () => {
  const live = [{ ref: 'land/bro-100-x', lastActivityAt: ago(LIVE_LAND_REF_MS - H) }];
  assert.deepEqual(decide({ landRefs: live }), { action: 'skip', reason: 'live-land-ref' });
  assert.equal(decide({ landRefs: [{ ref: 'land/bro-100-x', lastActivityAt: null }] }).reason, 'live-land-ref');
  const old = [{ ref: 'land/bro-100-old', lastActivityAt: ago(LIVE_LAND_REF_MS + H) }];
  const d = decide({ landRefs: old });
  assert.equal(d.action, 'todo');
  assert.deepEqual(d.staleRefs, ['land/bro-100-old']);
  assert.match(buildReclaimComment(d, NOW), /land\/bro-100-old/);
  assert.equal(decide({ landRefs: [...old, ...live] }).reason, 'live-land-ref');
});

test('latest session report blocked keeps the card; an older blocked report does not', () => {
  const blocked = { body: buildOutcomeCommentBody({ summary: 'needs creds', status: 'blocked' }), createdAt: ago(50 * H) };
  assert.equal(decide({ comments: [blocked] }).reason, 'blocked-report');
  const later = { body: buildOutcomeCommentBody({ summary: 'tried again', status: 'in-review' }), createdAt: ago(49 * H) };
  assert.equal(decide({ comments: [blocked, later] }).action, 'todo');
});

test('a truncated comment thread is skipped', () => {
  const comments = Array.from({ length: COMMENT_CAP }, (_, i) => ({ body: `note ${i}`, createdAt: ago(60 * H) }));
  assert.equal(decide({ comments }).reason, 'comments-truncated');
});

test('repeat reclaims send the card to Backlog after MAX_RECLAIMS', () => {
  const first = buildReclaimComment(decide(), NOW);
  assert.ok(first.startsWith(RECLAIM_MARKER));
  const prior = (n) => Array.from({ length: n }, () => ({ body: first, createdAt: ago(100 * H) }));
  assert.equal(decide({ comments: prior(MAX_RECLAIMS - 1) }).action, 'todo');
  const d = decide({ comments: prior(MAX_RECLAIMS) });
  assert.equal(d.action, 'backlog');
  assert.match(buildReclaimComment(d, NOW), /Backlog/);
});

test('a recent comment counts as activity even when updatedAt is old', () => {
  assert.equal(decide({ comments: [{ body: 'still on it', createdAt: ago(2 * H) }] }).reason, 'recent-comment');
  const d = decide({ comments: [{ body: 'old note', createdAt: ago(RECLAIM_IDLE_MS + 30 * H) }] });
  assert.equal(d.action, 'todo');
  assert.equal(d.idleHours, RECLAIM_IDLE_MS / H + 1);
});

test('findReclaimCandidates filters on list fields, oldest first, uncapped', () => {
  const issues = [
    card({ identifier: 'BRO-1', updatedAt: ago(RECLAIM_IDLE_MS + 5 * H) }),
    card({ identifier: 'BRO-2', updatedAt: ago(RECLAIM_IDLE_MS + 50 * H) }),
    card({ identifier: 'BRO-3', updatedAt: ago(H) }),
    card({ identifier: 'BRO-4', state: { name: 'Backlog', type: 'backlog' } }),
    card({ identifier: 'BRO-5', updatedAt: ago(RECLAIM_IDLE_MS + 9 * H) }),
    null,
  ];
  assert.deepEqual(findReclaimCandidates(issues, { nowMs: NOW }).map((i) => i.identifier), ['BRO-2', 'BRO-5', 'BRO-1']);
  assert.equal(reclaimListSkipReason(null, NOW), 'not-started');
});

// ── BRO-6085: In Review cards with only a Dispatched comment; dispatch-time blocked reports ──
const IN_REVIEW = { name: 'In Review', type: 'started' };
const dispatched = (t = 60 * H) => ({ body: 'Dispatched ab12cd34 to linear:BRO-100-x at 2026-10-09T00:00:00Z (headless)', createdAt: ago(t) });
const report = (status, t) => ({ body: buildOutcomeCommentBody({ summary: 'x', status }), createdAt: ago(t) });

test('In Review card with only a Dispatched comment goes back to Todo, comment names In Review', () => {
  const d = decide({ issue: { state: IN_REVIEW, description: 'no check here' }, comments: [dispatched()] });
  assert.equal(d.action, 'todo');
  assert.equal(d.priorState, 'In Review');
  assert.match(buildReclaimComment(d, NOW), /sat In Review/);
  assert.match(buildReclaimComment(decide(), NOW), /sat In Progress/);
});

test('In Review card with a session report, a human comment, an owner marker or gate evidence is kept', () => {
  const inReview = (o) => decide({ issue: { state: IN_REVIEW, description: 'plain', ...o.issue }, comments: o.comments });
  assert.equal(inReview({ comments: [dispatched(), report('in-review', 55 * H)] }).reason, 'in-review-reported');
  assert.equal(inReview({ comments: [dispatched(), report('blocked', 50 * H)] }).reason, 'in-review-reported');
  assert.equal(inReview({ comments: [dispatched(), { body: 'looks fine to me', createdAt: ago(55 * H) }] }).reason, 'in-review-engaged');
  assert.equal(inReview({ issue: { description: 'DECISION NEEDED: pick' }, comments: [dispatched()] }).reason, 'owner-marker');
  assert.equal(inReview({ issue: { labels: { nodes: [{ name: 'awaiting-owner' }] } }, comments: [dispatched()] }).reason, 'owner-marker');
  assert.equal(inReview({ issue: { description: 'VERIFY: node --test scripts/lib/x.test.mjs' }, comments: [dispatched()] }).reason, 'closer-owns');
  assert.equal(inReview({ issue: { description: 'PR-EVIDENCE: merged deployed checked (https://github.com/o/r/pull/1)' }, comments: [dispatched()] }).reason, 'closer-owns');
});

test('a recent Dispatched comment keeps an In Review card (48h applies to comments too)', () => {
  assert.equal(decide({ issue: { state: IN_REVIEW, description: 'plain' }, comments: [dispatched(H)] }).reason, 'recent-comment');
});

test('a blocked report within 5 min of a Dispatched comment does not pin the card; a later one does', () => {
  const at = 60 * H;
  const nearBefore = report('blocked', at + 30 * 1000);
  const nearAfter = report('blocked', at - 4 * 60 * 1000);
  const far = report('blocked', at - DISPATCH_BLOCKED_WINDOW_MS - 60 * 1000);
  assert.equal(decide({ comments: [dispatched(at), nearBefore] }).action, 'todo');
  assert.equal(decide({ comments: [dispatched(at), nearAfter] }).action, 'todo');
  assert.equal(decide({ comments: [dispatched(at), far] }).reason, 'blocked-report');
  assert.equal(decide({ comments: [far] }).reason, 'blocked-report');
  assert.equal(isDispatchTimeBlocked(nearBefore, [dispatched(at), nearBefore]), true);
  assert.equal(isDispatchTimeBlocked(report('paused', at), [dispatched(at)]), false);
});

test('repeat reclaims still cap a dispatch-time-blocked card at Backlog', () => {
  const prior = Array.from({ length: MAX_RECLAIMS }, () => ({ body: `${RECLAIM_MARKER} x`, createdAt: ago(100 * H) }));
  const at = 60 * H;
  assert.equal(decide({ comments: [...prior, dispatched(at), report('blocked', at + 1000)] }).action, 'backlog');
});

test('an In Review card needs a Dispatched receipt: zero comments or claim-only is kept', () => {
  const inReview = (comments) => decide({ issue: { state: IN_REVIEW, description: 'plain' }, comments });
  assert.equal(inReview([]).reason, 'in-review-no-dispatch');
  assert.equal(inReview([{ body: 'Claimed by local session x on host at 2026-10-09T00:00:00Z', createdAt: ago(60 * H) }]).reason, 'in-review-no-dispatch');
  const prior = { body: `${RECLAIM_MARKER} earlier`, createdAt: ago(100 * H) };
  assert.equal(inReview([prior, dispatched()]).reclaims, 1);
});
