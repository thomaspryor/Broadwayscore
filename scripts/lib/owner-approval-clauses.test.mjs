// BRO-7848: the push gate must read a clear owner "ship it" clause by clause.
// The three OWNER_YES messages are verbatim messages from 2026-11-19 that the old
// whole-message keyword check refused, costing the owner six repeated yeses.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyOwnerReply } from './owner-reply-classifier.mjs';
import { queryApprovalOf } from './transcript-scan.mjs';

const OWNER_YES = [
  "Yes\nBut fix the system so it's far less inefficient after",
  'Go',
  "okay, this has just gotten outrageous. I don't know how many times I need to say yes, do it, go, ship it, but get it done and then use Opus plan to figure out how I never have to fall into this heinous trap again.",
  'ship it',
  'yes',
  'Ship all four',
  'looks good',
  'go!',
  'yes, go ahead',
  'Go. Ship it.',
];

// Every one of these is a stop or a conditional: approving it would ship against the owner's wish.
const MUST_NOT_APPROVE = [
  "don't ship",
  'do not push it yet',
  'yes but wait',
  'looks good, fix the padding first',
  'go back and change the color',
  'no',
  'not yet',
  'hold on',
  'send me the screenshots first',
  'looks good except the footer',
  'yes, unless mobile is broken',
  'Yes after you fix the padding',
  'ship it once the build is green',
  'looks great but I want to see mobile before we push',
  "ship it? I'm not sure",
  'not sure, go',
  'do it later',
  "yes I'd rather you didn't",
  'love it, though the footer is off',
  'please hold',
  'actually wait',
  'nah',
  'I said don’t push it yet',
  'ship it? no wait',
  // Second-review findings (BRO-7848): negation split from its verb, partial approvals, conditions, delays.
  "don't. ship. it.", 'do. not. ship.', 'ship it, NOT', 'yes. kidding. don’t.',
  'yes but not the header', 'ship it but not the footer', 'looks good but not on mobile', 'nice but not quite',
  'I said yes to the copy, not the layout', 'ship version B not A', 'not A, ship B',
  'yes but let me check', 'yes but I need to see mobile', 'approve but I want to look again', 'yes but let me sleep on it',
  'ship it but only after review', 'looks good but the mobile is broken', 'yes but the header is wrong', 'yes, however the footer is off',
  'yes if tests pass', 'ship if green', 'deploy when CI passes', 'ship it when ready', 'yes, assuming tests pass',
  'yes provided it builds', 'yes as long as mobile works', 'yes, pending review', 'ship it next week', 'ship it monday',
  'ship it in an hour', 'ship it after lunch', 'ship it soon', 'approve after I look', 'ok nice, now show me mobile',
  'looks great, can you also show tablet', 'Yes\nhmm the mobile is off', 'yes\nactually, let me look again',
  'cannot ship this', "I wouldn't ship this", 'DO NOT SHIP', 'dont ship', 'sure, but not yet', "let's wait", 'yes\nactually hold off',
];

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
