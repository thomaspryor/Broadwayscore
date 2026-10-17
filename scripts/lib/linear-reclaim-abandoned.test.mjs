import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RECLAIM_IDLE_MS, LIVE_LAND_REF_MS, MAX_RECLAIMS, COMMENT_CAP, RECLAIM_MARKER,
  reclaimListSkipReason, findReclaimCandidates, reclaimDecision, buildReclaimComment,
} = require('./linear-reclaim-abandoned.js');
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

test('In Review, unstarted, owner and opted-out cards are kept', () => {
  assert.equal(decide({ issue: { state: { name: 'In Review', type: 'started' } } }).reason, 'in-review');
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
    card({ identifier: 'BRO-4', state: { name: 'In Review', type: 'started' } }),
    card({ identifier: 'BRO-5', updatedAt: ago(RECLAIM_IDLE_MS + 9 * H) }),
    null,
  ];
  assert.deepEqual(findReclaimCandidates(issues, { nowMs: NOW }).map((i) => i.identifier), ['BRO-2', 'BRO-5', 'BRO-1']);
  assert.equal(reclaimListSkipReason(null, NOW), 'not-started');
});
