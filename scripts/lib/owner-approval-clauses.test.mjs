// BRO-7848: the push gate must read a clear owner "ship it" clause by clause.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyOwnerReply } from './owner-reply-classifier.mjs';
import { queryApprovalOf } from './transcript-scan.mjs';
import { OWNER_YES, MUST_NOT_APPROVE } from './owner-reply-fixtures.mjs';

test('the owner messages that failed in production now approve', () => {
  for (const m of OWNER_YES) assert.equal(classifyOwnerReply(m), 'approve', m);
});

test('stops, conditions and delays never approve (fails toward asking)', () => {
  for (const m of MUST_NOT_APPROVE) assert.notEqual(classifyOwnerReply(m), 'approve', m);
});

test('chatter with no yes in it is neutral, not approval', () => {
  for (const m of ['what is the status', 'ok thanks', '', 'go look at the other page']) {
    assert.notEqual(classifyOwnerReply(m), 'approve', m);
  }
  assert.equal(classifyOwnerReply(null), 'neutral');
});

test('a trailing "then" does not break the split', () => {
  assert.equal(classifyOwnerReply('ship it then'), 'approve');
});

// Through the real gate entry point: only the newest owner message counts, so a stop
// after a yes cancels it, and an old yes never approves a newer verdict.
const VERDICT = '2026-11-19T10:00:00.000Z';
const ev = (text, ts) => ({ kind: 'user_text', text, ts, synthetic: false });

test('queryApprovalOf: the real owner fixtures approve after the verdict', () => {
  for (const m of OWNER_YES.slice(0, 3)) {
    const r = queryApprovalOf([ev(m, '2026-11-19T11:00:00.000Z')], 'a160efdea00f0bc7', { after: VERDICT });
    assert.equal(r.approved, true, m);
    assert.equal(r.via, 'plain-affirmative');
  }
});

test('queryApprovalOf: a later stop cancels an earlier yes, and an old yes is too old', () => {
  const yesThenStop = [ev('yes', '2026-11-19T11:00:00.000Z'), ev('wait, stop', '2026-11-19T11:05:00.000Z')];
  assert.equal(queryApprovalOf(yesThenStop, 'a160efdea00f0bc7', { after: VERDICT }).approved, false);
  const oldYes = [ev('yes', '2026-11-19T09:00:00.000Z')];
  assert.equal(queryApprovalOf(oldYes, 'a160efdea00f0bc7', { after: VERDICT }).approved, false);
});
