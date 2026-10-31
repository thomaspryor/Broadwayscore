import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { decideLandRefPrune, MIN_AGE_DAYS, ABANDONED_AFTER_DAYS } = createRequire(import.meta.url)('./land-ref-prune.js');

const now = Date.parse('2026-10-24T12:00:00Z');
const ago = (days) => new Date(now - days * 86400000).toISOString();
const d = (o) => decideLandRefPrune({ tipCommittedAt: ago(5), compareStatus: 'ahead', runInFlight: false, cardStateType: 'completed', runIdleDays: null, openPr: false, cardLookupFailed: false, now, ...o });

describe('decideLandRefPrune (BRO-6103)', () => {
  it('prunes a ref whose tip is already on main', () => {
    assert.deepEqual(d({ compareStatus: 'behind' }), { prune: true, reason: 'merged' });
    assert.deepEqual(d({ compareStatus: 'identical' }), { prune: true, reason: 'merged' });
  });
  it('never touches a ref younger than the minimum age, merged or not', () => {
    assert.equal(d({ tipCommittedAt: ago(MIN_AGE_DAYS - 0.5), compareStatus: 'behind' }).reason, 'too-young');
  });
  it('keeps unmerged work until it is abandoned', () => {
    assert.equal(d({ compareStatus: 'ahead', tipCommittedAt: ago(ABANDONED_AFTER_DAYS - 1) }).reason, 'recent-unmerged');
    assert.equal(d({ compareStatus: 'diverged', tipCommittedAt: ago(ABANDONED_AFTER_DAYS + 1) }).reason, 'abandoned');
  });
  it('keeps a ref with a Land run in flight', () => {
    assert.equal(d({ compareStatus: 'behind', runInFlight: true }).reason, 'land-run-in-flight');
  });
  it('keeps an old unmerged ref whose card is In Progress or unreadable', () => {
    const old = { tipCommittedAt: ago(30), compareStatus: 'ahead' };
    assert.equal(d({ ...old, cardStateType: 'started' }).reason, 'card-open');
    assert.equal(d({ ...old, cardStateType: 'backlog' }).reason, 'card-open');
    assert.equal(d({ ...old, cardStateType: 'unstarted' }).reason, 'card-open');
    assert.equal(d({ ...old, cardLookupFailed: true, cardStateType: null }).reason, 'card-unreadable');
    assert.equal(d({ ...old, cardStateType: null }).prune, true, 'a name with no card is abandoned by age alone');
  });
  it('keeps a ref whose tip date cannot be read', () => {
    assert.equal(d({ tipCommittedAt: null, compareStatus: 'behind' }).reason, 'tip-date-unreadable');
  });
  it('keeps a ref that has a recent Land run or an open PR, however old its tip commit', () => {
    const old = { tipCommittedAt: ago(30), compareStatus: 'ahead' };
    assert.equal(d({ ...old, runIdleDays: 1 }).reason, 'recent-land-run');
    assert.equal(d({ ...old, runIdleDays: 20 }).prune, true);
    assert.equal(d({ ...old, openPr: true }).reason, 'open-pr');
    assert.equal(d({ compareStatus: 'behind', openPr: true }).reason, 'open-pr');
  });
  it('keeps on unreadable compare, unparseable date and unknown card state', () => {
    assert.equal(d({ compareStatus: null, tipCommittedAt: ago(5) }).reason, 'recent-unmerged');
    assert.equal(d({ tipCommittedAt: 'not-a-date' }).reason, 'tip-date-unreadable');
    assert.equal(d({ tipCommittedAt: ago(30), compareStatus: 'ahead', cardStateType: 'triage' }).reason, 'card-open');
  });
});
