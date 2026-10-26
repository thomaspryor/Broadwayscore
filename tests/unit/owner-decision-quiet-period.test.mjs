// BRO-6266: decision emails must not re-ask a decision the owner already
// answered (recorded, in a chat a session is still working, or in a plain
// comment), and the digest/roundup use the same test. require()s the real code (rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qp = require('../../scripts/lib/owner-decision-quiet-period.js');
const lsr = require('../../scripts/lib/linear-session-reporting.js');
const zs = require('../../scripts/lib/linear-started-zombie-sweep.js');
const link = require('../../src/lib/owner-decision-link.js');
const { buildDecisionsSection } = require('../../scripts/lib/owner-decision-notify.js');
const { buildDecisionEmail } = require('../../scripts/lib/owner-decision-email.js');
const { resolveDecision, parseArgs } = require('../../scripts/record-owner-answer.js');
const { parseArgs: dispatchArgs } = require('../../scripts/cloud-dispatch.js');

const SECRET = 'test-secret';
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ENV = {};
const min = (m) => new Date(NOW - m * 60000).toISOString();

const DESC = [
  'Some context.',
  '',
  'DECISION NEEDED: Approve the 10-day hand test?',
  'Why this is your call: costs money.',
  'Option A — Approve: learn fast / costs $20',
  'Option B — Wait: free / slower',
  'My recommendation: A because it is cheap.',
  'Default: wait.',
].join('\n');

function card({ comments = [], createdAt = min(3000), description = DESC, labels = [] } = {}) {
  return { identifier: 'BRO-1', title: 'Hand test', description, url: 'https://linear.app/x/issue/BRO-1', createdAt, priority: 2,
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: comments.map(([body, at], i) => ({ id: `c${i}`, body, createdAt: at })) } };
}
const decisionOf = (issue) => ({ identifier: issue.identifier, title: issue.title, question: 'Approve the 10-day hand test?' });
const hold = (issue) => qp.holdReason(issue, decisionOf(issue), { secret: SECRET, now: NOW, env: ENV });
const answerMarkerFor = (issue) => link.answerMarker(link.decisionRef(SECRET, issue.identifier, link.questionHash('Approve the 10-day hand test?')));

test('a quiet card with no answer is asked', () => {
  assert.equal(hold(card()), null);
  assert.equal(hold(card({ comments: [['Claimed by a session. Working on the scraper.', min(200)]] })), null);
});

test('BRO-6250: a session comment in the last 90 minutes holds the email until the card is quiet', () => {
  const working = card({ comments: [['Session report: owner approved option A for voiced formats, implementing now.', min(14)]] });
  assert.equal(hold(working).reason, 'recent-activity');
  assert.equal(hold(card({ comments: [['Session report: still working.', min(89)]] })).reason, 'recent-activity');
  assert.equal(hold(card({ comments: [['Session report: still working.', min(91)]] })), null);
  assert.equal(qp.isQuiet(working, NOW), false);
  assert.equal(qp.QUIET_MS, 90 * 60000);
  // A card that gets a comment every hour does not hold the email forever: after 12 hours of unbroken activity it goes out.
  const hourly = (n) => Array.from({ length: n }, (_, i) => ['Session report: still working.', min(10 + i * 60)]);
  assert.equal(hold(card({ comments: hourly(13) })), null);
  assert.equal(hold(card({ comments: hourly(11) })).reason, 'recent-activity');
  // A gap of 90 minutes or more starts a new run.
  const oldRun = Array.from({ length: 12 }, (_, i) => ['Session report: earlier work.', min(5 * 60 + i * 60)]);
  assert.equal(hold(card({ comments: [...hourly(3), ...oldRun] })).reason, 'recent-activity');
});

test('our own marker comments never count as activity', () => {
  const issue = card({ comments: [[`Emailed the owner this decision.\n\n${link.emailMarker('abc123')}`, min(5)], [`Listed.\n\nVisual approval ref VQAdeadbeef00`, min(3)]] });
  assert.equal(qp.lastActivityAt(issue), null);
  assert.equal(hold(issue), null);
});

test('a recorded "Owner decision" for this question is answered, for every caller', () => {
  const issue = card({ comments: [[`**Owner decision** (answered by the owner through a chat with Claude)\n\nChose: Option A\n\n${answerMarkerFor(issue0())}`, min(600)]] });
  assert.equal(hold(issue).reason, 'answered');
  assert.equal(qp.isAlreadyAnswered(issue, decisionOf(issue), SECRET), true);
  // A marker for a different question does not count.
  const other = card({ comments: [[link.answerMarker(link.decisionRef(SECRET, 'BRO-1', link.questionHash('Another question?'))), min(600)]] });
  assert.equal(qp.isAlreadyAnswered(other, decisionOf(other), SECRET), false);
  // The kill switch never re-asks a recorded answer.
  assert.equal(qp.holdReason(issue, decisionOf(issue), { secret: SECRET, now: NOW, env: { OWNER_DECISION_HOLDS_DISABLED: '1' } }).reason, 'answered');
});
function issue0() { return card(); }

test('BRO-6111/6112: a plain comment that reads like an answer holds the email', () => {
  for (const body of ["Didn't I do this already?", 'Didn’t I do this already? Not all of them, but the ones Claude thought was safe', 'A', 'Option B.', 'go with A',
    'Yes, approve it', 'I already answered this in the chat', 'ANSWER: A', 'Why do I need to review this?',
    'There are some things that only can be done on the mac. So we should keep it for cards/work that needs it, but default to the cloud']) {
    const h = hold(card({ comments: [[body, min(600)]] }));
    assert.equal(h && h.reason, 'maybe-answered', body);
    assert.match(h.detail, /may already answer it$/);
    // The emailer's run log is public: the comment's words never go in the detail.
    assert.ok(!h.detail.includes(body.slice(0, 12)) || body.length < 3, body);
  }
});

test('session-style comments are not mistaken for an answer', () => {
  // Real session comments from open cards (2026-10-26 corpus).
  for (const body of ['Dispatched to a worker.', 'PR merged, deploy pending.', 'Already dispatched, see run.', '## Outcome\n- A thing\n- Another',
    'DECISION NEEDED: restated question\nOption A — x / y', 'Abandoning this approach.',
    'ship-check: pass after fixes. 0 P0; 1 P1 fixed (syndication shield ignored primaries)', 'Raised to P2: 120 plans are pending or partial, not 4.',
    'Unparked: a worker can do this (retune or fix the outlier inputs); no owner call needed.', 'OWNER CORRECTION, 24 October: Tom says the Resend item is an error. Ignore it.',
    'Claimed then released unworked: the Claude lane hit its 4-card cap this firing.', 'Landed 2d219a8b783: codex-runner.yml scheduled runs now default to lane=gha',
    'Codex runner was stopped at the 2-hour background limit before this card finished (no landing). Returned to Todo for the next run.',
    // Sessions address the owner; that is not the owner's voice.
    'Waiting on you to pick one of the options above.', 'Unblocked once you decide.', 'Can you look at this tomorrow?', 'Yes, the build is green now.']) {
    assert.equal(hold(card({ comments: [[body, min(600)]] })), null, body);
  }
});

test('a comment older than the restated decision does not hold it', () => {
  const issue = card({ comments: [['A', min(900)], ['Parked. DECISION NEEDED: Approve the 10-day hand test?', min(800)]] });
  assert.equal(hold(issue), null);
});

test('the kill switch turns off the quiet period and the maybe-answered hold', () => {
  const issue = card({ comments: [['A', min(10)]] });
  assert.equal(qp.holdReason(issue, decisionOf(issue), { secret: SECRET, now: NOW, env: { OWNER_DECISION_HOLDS_DISABLED: '1' } }), null);
});

test('a catch-up sweep of old cards always goes out as the one backlog email', () => {
  const old = (n) => Array.from({ length: n }, (_, i) => ({ identifier: `BRO-${i}`, createdAt: min(2 * 24 * 60) }));
  assert.equal(qp.sendMode(old(2), { backlogMin: 3, now: NOW }), 'each');
  assert.equal(qp.sendMode(old(3), { backlogMin: 3, now: NOW }), 'backlog');
  // Even if BACKLOG_MIN is raised later, more than 3 old cards never go out one by one.
  assert.equal(qp.sendMode(old(4), { backlogMin: 10, now: NOW }), 'backlog');
  assert.equal(qp.sendMode(old(3), { backlogMin: 10, now: NOW }), 'each');
  assert.equal(qp.MAX_OLD_INDIVIDUAL, 3);
});

test('the digest drops an answered decision and flags a maybe-answered one (same test as the email)', () => {
  const answered = card({ comments: [[answerMarkerFor(issue0()), min(600)]] });
  assert.equal(buildDecisionsSection([answered], { now: new Date(NOW), secret: SECRET }), null);
  const maybe = card({ comments: [["Didn't I do this already?", min(600)]] });
  const s = buildDecisionsSection([maybe], { now: new Date(NOW), secret: SECRET });
  assert.equal(s.items.length, 1);
  assert.match(s.items[0].detail, /may have answered this already/);
  const open = buildDecisionsSection([card()], { now: new Date(NOW), secret: SECRET });
  assert.doesNotMatch(open.items[0].detail, /may have answered/);
});

test('the decision email tells the owner how to record a chat answer', () => {
  const issue = card();
  const d = { identifier: 'BRO-1', title: issue.title, question: 'Approve the 10-day hand test?', url: issue.url };
  const { html } = buildDecisionEmail({ decision: d, description: issue.description, secret: SECRET });
  assert.match(html, /If you already answered this in a Claude chat, tell that chat 'record my answer' and it will be saved here\./);
});

test('the recorder maps the choice to the card\'s own options and refuses the wrong ones', () => {
  const r = resolveDecision(card(), 'a');
  assert.equal(r.choiceKey, 'a');
  assert.equal(r.decision.hash, link.questionHash('Approve the 10-day hand test?'));
  assert.match(resolveDecision(card(), 'c').error, /not one of this card's choices: a, b, own/);
  assert.equal(resolveDecision(card(), 'own').choiceKey, 'own');
  // A card without lettered options offers approve/reject, so "a" is refused, not guessed.
  const plain = card({ description: 'DECISION NEEDED: Turn on the new crawler?' });
  assert.match(resolveDecision(plain, 'a').error, /approve, reject, own/);
  assert.equal(resolveDecision(plain, 'approve').choiceKey, 'approve');
  assert.match(resolveDecision(card({ description: 'Nothing to decide.' }), 'a').error, /no open DECISION NEEDED/);
  // Two open questions: a letter could belong to either, so the recorder refuses.
  const two = card({ description: `${DESC}\n\nDECISION NEEDED: Also turn on the crawler?\nOption A — Yes: x / y\nOption B — No: x / y` });
  assert.match(resolveDecision(two, 'a').error, /2 DECISION NEEDED questions/);
});

test('the recorder refuses visual-approval cards (approving one ships the change)', () => {
  const desc = `DECISION NEEDED: Does the change to the homepage look right? (ref ${'0'.repeat(32)})\nOption A — approve: ship / x\nOption B — reject: fix / y\nVISUAL-APPROVAL: patch=${'a'.repeat(40)} verdict=${'b'.repeat(12)} hold=visual-hold/x`;
  assert.match(resolveDecision(card({ description: desc }), 'a').error, /visual change/);
});

test('recorder arguments: card id, choice, own needs text, via is sanitised', () => {
  assert.throws(() => parseArgs(['nope', '--choice', 'a']), /card id/);
  assert.throws(() => parseArgs(['BRO-5', '--choice', 'own']), /needs --text/);
  const o = parseArgs(['bro-5', '--choice', 'A', '--via', 'chat\nDECISION NEEDED: x']);
  assert.equal(o.id, 'BRO-5');
  assert.equal(o.choice, 'a');
  assert.doesNotMatch(o.via, /DECISION NEEDED|\n/);
  // Parallel recordings are told apart by card id, and the answer text stays out of the title.
  // In CI the owner's words come from the event payload, never argv or env (public log).
  const ev = parseArgs(['BRO-5', '--choice', 'own', '--inputs-from-event', '--execute'], { readEvent: () => ({ text: 'Do it next week', via: 'chat' }) });
  assert.equal(ev.text, 'Do it next week');
  assert.equal(ev.via, 'chat');
  assert.throws(() => parseArgs(['BRO-5', '--choice', 'own', '--inputs-from-event'], { readEvent: () => ({}) }), /needs --text/);
  assert.equal(dispatchArgs(['record-owner-answer.yml', '-f', 'issue=BRO-5', '-f', 'text=secret words']).match, 'record-owner-answer BRO-5 [');
});

// BRO-6357: dispatcher and watchdog receipts say a job started or ended, not that someone is working the card.
const ld = require('../../scripts/lib/linear-dispatch.js');
const her = require('../../scripts/lib/linear-session-reporting.js');
const wd = require('../../scripts/lib/dispatch-watchdog-core.js');

test('BRO-6357: dispatch, headless-ended and watchdog receipts do not hold the email', () => {
  const receipts = [
    ld.buildDispatchComment({ ref: 'linear:BRO-1-abc', ts: min(5), mode: 'headless', correlationId: '66746217' }),
    ld.buildDispatchComment({ ref: 'linear:BRO-1-abc', ts: min(5), mode: 'cmux' }),
    `${her.HEADLESS_END_MARKER} (killed-timeout).`,
    lsr.buildOutcomeCommentBody({ status: 'blocked', summary: `${wd.WATCHDOG_SAFETY_NET_PREFIX} headless job 12 ended THIS SESSION: BLOCKED.` }),
    lsr.buildOutcomeCommentBody({ status: 'paused', summary: `${zs.ZOMBIE_RESET_MARKER}: BRO-1's most recent dispatch died.` }),
  ];
  for (const body of receipts) {
    assert.match(body, qp.MACHINE_RECEIPT_RE, body);
    assert.equal(hold(card({ comments: [[body, min(5)]] })), null, body);
    assert.equal(qp.isQuiet(card({ comments: [[body, min(5)]] }), NOW), true);
  }
  // Receipts also cannot extend a streak of real activity.
  const real = ['Session report: still working.', min(100)];
  assert.equal(hold(card({ comments: [real, [receipts[0], min(10)]] })), null);
});

test('BRO-6357: a claim, a session report or a person still hold the email', () => {
  const claim = her.buildClaimComment({ sessionRef: 'https://claude.ai/code/session_x', ts: min(10) });
  assert.doesNotMatch(claim, qp.MACHINE_RECEIPT_RE);
  assert.equal(hold(card({ comments: [[claim, min(10)]] })).reason, 'recent-activity');
  assert.equal(hold(card({ comments: [['**Session report (done)**\n\nFinished the work.', min(10)]] })).reason, 'recent-activity');
  // A receipt newer than the real activity does not hide it.
  const rcpt = ld.buildDispatchComment({ ref: 'r', ts: min(2), mode: 'headless' });
  assert.equal(hold(card({ comments: [['Session report: still working.', min(20)], [rcpt, min(2)]] })).reason, 'recent-activity');
});

test('BRO-6357: markdown-escaped receipts are still recognised', () => {
  const escaped = ld.buildDispatchComment({ ref: 'linear:BRO-1-x_y', ts: min(5), mode: 'headless' }).replace(/_/g, '\\_');
  assert.equal(hold(card({ comments: [[escaped, min(5)]] })), null);
});
