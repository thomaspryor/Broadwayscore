// BRO-6357: a card waiting on the owner's visual approval cannot be sent to a headless worker,
// and a later "not an owner decision" comment cannot clear it. require()s the real code (rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hd = require('../../scripts/lib/headless-dispatchability.js');
const va = require('../../scripts/lib/visual-approval.js');

const block = va.buildBlock({
  what: 'the Money gate error states', patch: 'd0fb4fbfd549839526bdbcb1befb4d4fae2d3314', verdict: '8501c2bd9267fad6',
  hold: 'visual-hold/bro-6339', evidence: [], summary: 'the automatic visual checks passed',
});
const notes = `Reject fake emails.\n\n## Acceptance criteria\n\n* refused\n  VERIFY: node --test tests/unit/money-gate.test.mjs\n\n${block}`;
const classify = (comments) => hd.classifyHeadlessDispatchability({ subject: 'Money gate', notes, comments }, { verifyCmd: 'node --test x' });
const codes = (r) => r.blockers.map((b) => b.code);

test('a waiting visual ask blocks headless dispatch', () => {
  assert.deepEqual(codes(classify([])), ['OWNER_DECISION_GATE']);
  assert.equal(hd.visualAskOpen(notes, []), true);
});

test('a later comment cannot clear a waiting visual ask', () => {
  for (const c of ['not an owner decision, it is blocked on X', 'OWNER-CLEARED: fine to run']) {
    assert.deepEqual(codes(classify(['Asked the owner to look at 5 screenshot(s).', c])), ['OWNER_DECISION_GATE'], c);
  }
  assert.equal(hd.visualAskOpen(notes, ['x']), true);
});

test('a re-ask after an expiry holds again; markers from the earlier ask do not count', () => {
  assert.equal(hd.visualAskOpen(notes, [va.MARK.expired, 'Asked the owner to look at 2 screenshot(s).']), true);
  assert.equal(hd.visualAskOpen(notes, ['Asked the owner to look at 2 screenshot(s).', va.MARK.expired]), false);
  assert.equal(hd.visualAskOpen(notes, [null, undefined]), true);
});

test('an approved-and-pending ask also holds; a rejected one goes back to a worker', () => {
  assert.equal(hd.visualAskOpen(notes, [`${va.MARK.approved} abc`]), true);
  const rejected = `${notes.replace(/^DECISION NEEDED:/m, 'ANSWERED by the owner: reject\nDECISION NEEDED:')}`;
  assert.equal(hd.visualAskOpen(rejected, []), false);
});

test('an ordinary DECISION NEEDED card can still be cleared by an explicit comment', () => {
  const plain = 'Do it.\n\nDECISION NEEDED: pick one?\nOption A — x: a / b';
  const r = hd.classifyHeadlessDispatchability({ subject: 's', notes: plain, comments: ['OWNER-CLEARED: go'] }, { requireVerifyCmd: false });
  assert.equal(r.dispatchable, true);
});
