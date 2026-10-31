// BRO-6168: the owner's reply on a DECISION NEEDED card must act. Real card texts
// (BRO-6110, BRO-6111, BRO-6112 shapes); the test requires the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reply = require('../../scripts/lib/decision-reply.js');
const { parseDecisionDescription, findDecisionQuestion } = require('../../scripts/lib/decision-card-parse.js');
const { verifyCommand } = require('../../scripts/lib/linear-drain-parked.js');
const { headlessUnfitReason } = require('../../scripts/lib/cloud-worker-pick.js');
const { findOwnerDecisions, formatEmail, planNotification } = require('../../scripts/lib/owner-decision-notify.js');

const DATE = '2026-10-24';
const B6111 = [
  'PARKED: owner decision', '',
  'DECISION NEEDED: Retire the Mac dispatch fleet (cmux + headless jobs, \\~79 supervision files) in favour of cloud board workers?',
  'Why this is your call: cloud-worker-pick lacks attempt memory/retry cap/spend breaker and only takes P0/P1; Mac is \\~33% trouble rate. Trade-off of reliability vs capability.',
  'Option A - Cut over after cloud worker gets caps: more reliable / weeks of work.',
  'Option B - Keep Mac for now: no risk / ongoing Mac-infra failures (\\~241 titles since 08-11).',
  'My recommendation: A, staged, because cloud sessions proved more reliable.',
  'Default: Mac fleet stays.', 'Context: BRO-4622 plan, BRO-5846.', '', 'Filed by: session (kind: cut over mac dispatch fleet cloud workers)',
].join('\n');
const B6112 = [
  'PARKED: owner decision', '',
  'DECISION NEEDED: Cloud lacks 8 of 13 Tier-1 keys (BRIGHTDATA\\_*, SCRAPINGBEE, BROWSERBASE\\_*, RESEND, ANTHROPIC). Needed to move the cloud Morning email (RESEND) and scraping jobs off the Mac.',
  'Why this is your call: pasting production secrets into the cloud environment is a security/spend decision.',
  'Option A - Add RESEND only: unblocks the morning email, newsletter review, opening-night backup routines / scraping stays on Mac.',
  'Option B - Add all 8 in [claude.ai](<http://claude.ai>) environment settings: full cloud move / larger secret exposure.',
  'My recommendation: A now, B later.', 'Default: the three Mac email jobs keep running; BRO-5846 routine recreation stays blocked.', 'Context: BRO-5846 item 1.',
].join('\n');
const B6110_OPEN = [
  'DECISION NEEDED: Do you still use Cyrus (Linear agent)? The relay [https://cyrus-relay.vercel.app](<https://cyrus-relay.vercel.app>) now returns 404, so cyrus-webhook-drain logs fetch failed every tick.',
  'Option A - Retire: add the two jobs to config/mac-retired.json; no more error noise / lose Cyrus.',
  'Option B - Keep: redeploy the relay on Vercel; costs a deploy + upkeep.',
  'My recommendation: A.', '', '## Acceptance criteria', '', 'VERIFY: node --test tests/unit/mac-cloud-routines-verification.test.mjs',
].join('\n');
const B6110_DONE = 'ANSWERED 2026-10-24: owner chose Option A (retire Cyrus). Owner answered "A" on this card at 19:01 UTC.\n\nOption A (chosen) - Retire: x\nOption B (not chosen) - Keep: y';

const c = (body, at) => ({ id: `c-${at}`, body, createdAt: `2026-10-24T${at}:00.000Z` });
const issue = (description, comments, extra = {}) => ({
  identifier: 'BRO-X', title: 'DECISION NEEDED: a question', description, priority: 3,
  state: { type: 'backlog', name: 'Backlog' }, comments: { nodes: comments }, labels: { nodes: [] }, ...extra,
});
const plan = (i) => reply.planReply(i, { date: DATE, verifyCommand, unfitReason: (x) => headlessUnfitReason(x) });

test('letter replies are picks, only for options on the card', () => {
  const card = parseDecisionDescription(B6111);
  for (const body of ['A', 'a', 'A.', 'A\n', 'Option B', 'option b', 'go with A', "I'll pick B", '**A**', 'A please']) {
    const r = reply.parseReply(body, card);
    assert.equal(r.kind, 'pick', body);
    assert.equal(r.key, body.replace(/[^ab]/gi, '').slice(-1).toUpperCase());
  }
  assert.equal(reply.parseReply('C', card).kind, 'unclear');
  assert.equal(reply.parseReply('A', parseDecisionDescription('DECISION NEEDED: yes or no?')).kind, 'unclear');
});

test('yes picks the recommended option only when the card names one', () => {
  assert.deepEqual(reply.parseReply('yes', parseDecisionDescription(B6111)), { kind: 'pick', key: 'A', via: 'yes' });
  const noRec = parseDecisionDescription(B6111.replace(/^My recommendation.*$/m, ''));
  assert.equal(reply.parseReply('yes', noRec).kind, 'unclear');
});

test('machine and session comments are never the owner reply', () => {
  const card = parseDecisionDescription(B6111);
  for (const body of ['Working on it', 'Done.', 'Session paused: waiting for owner', 'ok', 'sounds good', 'Claimed by https://claude.ai/code/session_x at 2026-10-24T19:15:53Z', 'Owner answered: Option A (x), by replying "A" on 2026-10-24.',
    'Dispatched abc to cmux', '[auto-fix-attempted:fail] nope', 'Outcome: did A', 'A https://x.test', 'A\nand more', 'Waiting on your approval: ' + 'x'.repeat(250), '']) {
    assert.equal(reply.parseReply(body, card).kind, 'ignore', body);
  }
  assert.equal(reply.findReplyComment([c('Claimed by x', '10:00'), c('Dispatched y', '10:05')], card), null);
});

test('only comments after the last settled marker count', () => {
  const comments = [c('A', '10:00'), c('Owner answered: Option A, by replying "A" on 2026-10-24.', '10:05'), c('B', '10:10')];
  const card = parseDecisionDescription(B6111);
  assert.equal(reply.findReplyComment(comments, card).comment.body, 'B');
  assert.equal(reply.findReplyComment(comments.slice(0, 2), card), null);
});

test('BRO-6110 shape: an already answered card is not a candidate', () => {
  assert.equal(findDecisionQuestion(B6110_DONE), null);
  assert.equal(plan(issue(B6110_DONE, [c('A', '19:01')])).action, 'skip');
});

test('BRO-6110 open shape with a safe VERIFY: dispatch, ANSWERED line, no live marker, title cleaned', () => {
  const p = plan(issue(B6110_OPEN, [c('A', '19:01')]));
  assert.equal(p.action, 'dispatch');
  assert.match(p.verify, /node --test tests\/unit\/mac-cloud-routines-verification\.test\.mjs/);
  assert.match(p.description, /^ANSWERED 2026-10-24: owner chose Option A \(Retire\)\./m);
  assert.match(p.description, /^To do: carry out Option A/m);
  assert.equal(findDecisionQuestion(p.description), null);
  assert.doesNotMatch(p.description, /https?:\/\//);
  assert.equal(p.title, 'a question');
  assert.equal(headlessUnfitReason({ title: p.title, description: p.description }), null);
});

test('BRO-6111 shape: the pick is recorded, no check on the card so a session must finish it', () => {
  const p = plan(issue(B6111, [c('A', '19:01')]));
  assert.equal(p.action, 'needs-session');
  assert.match(p.why, /no safe check command/);
  assert.match(p.description, /^UNPARKED \(BRO-6168 owner reply 2026-10-24\): owner decision/m);
  assert.doesNotMatch(p.description, /^PARKED/m);
  assert.equal(findDecisionQuestion(p.description), null);
});

test('BRO-6111: a safe VERIFY in a comment makes it dispatchable', () => {
  const p = plan(issue(B6111, [c('VERIFY: node --test tests/unit/decision-reply.test.mjs', '09:00'), c('A', '19:01')]));
  assert.equal(p.action, 'dispatch');
});

test('BRO-6112 shape: a secret option is never started, the owner is told what only they can do', () => {
  const p = plan(issue(B6112, [c('A', '19:01')]));
  assert.equal(p.action, 'owner-only');
  assert.match(p.ownerOnly, /key or password/);
  const d = reply.rewriteDescription(B6112, { key: 'A', name: p.name, upside: p.upside, date: DATE, tag: 't', ownerOnly: p.ownerOnly });
  assert.match(d, /^PARKED: owner action needed/m);
  assert.match(reply.ownerOnlyComment({ key: 'A', name: p.name, reason: p.ownerOnly }), /has to be done by you/);
});

test('spend, email to people and irreversible options need the owner', () => {
  const mk = (opt) => parseDecisionDescription(`DECISION NEEDED: q?\nOption A - ${opt}: up / down\nOption B - Leave it: none / none`);
  assert.match(reply.ownerOnlyReason(mk('Upgrade the paid plan'), 'A'), /money/);
  assert.match(reply.ownerOnlyReason(mk('Send an email to all subscribers'), 'A'), /email|key/);
  assert.match(reply.ownerOnlyReason(mk('Delete the old shows table'), 'A'), /undone/);
  assert.equal(reply.ownerOnlyReason(mk('Retire the Cyrus jobs'), 'A'), null);
});

test('an unclear short reply gets one plain question; chatter and long comments get none', () => {
  const p = plan(issue(B6111, [c('A and B', '19:01')]));
  assert.equal(p.action, 'clarify');
  const q = reply.clarifyComment({ options: p.card.options });
  assert.match(q, /^\[owner-reply-unclear\]/);
  assert.match(q, /one letter \(A, B\)/);
  assert.doesNotMatch(q, /claude/i);
  assert.equal(plan(issue(B6111, [c('A and B', '19:01'), c(q, '19:02')])).action, 'skip');
  assert.equal(plan(issue(B6111, [c('x'.repeat(300), '19:01')])).action, 'skip');
  assert.equal(plan(issue(B6111, [])).action, 'skip');
});

test('the Owner answered comment is what owner-decision-recall reads, and never quotes the question', () => {
  const { isAnswerComment } = require('../../scripts/lib/owner-decision-recall.js');
  const body = reply.answeredComment({ key: 'A', name: 'Retire', replyText: 'A', date: DATE }) + reply.dispatchedNote('node --test x');
  assert.match(body, /^Owner answered: Option A \(Retire\), by replying "A" on 2026-10-24\./);
  if (isAnswerComment) assert.ok(isAnswerComment({ body }));
  assert.doesNotMatch(body, /DECISION NEEDED/);
});

test('rewrite works on raw lines: code fences and inline code survive; placeholders are skipped', () => {
  const d = ['Example:', '```', 'DECISION NEEDED: <what, one sentence>', '```', 'DECISION NEEDED: Keep `foo`?', 'Option A - Keep: x / y'].join('\n');
  const out = reply.rewriteDescription(d, { key: 'A', name: 'Keep', upside: 'x', date: DATE, tag: 't' });
  assert.match(out, /```\nDECISION NEEDED: <what, one sentence>\n```/);
  assert.match(out, /^ANSWERED 2026-10-24: owner chose Option A \(Keep\)\. Question was: Keep \?/m);
  assert.equal(reply.rewriteDescription('nothing here', { key: 'A', date: DATE }), null);
});

test('the digest and email stop telling the owner a false thing and drop "tell Claude"', () => {
  const issues = [{ identifier: 'BRO-6111', title: 'DECISION NEEDED: Cut over?', description: B6111, priority: 3, url: 'u', createdAt: '2026-10-24T11:00:00Z' }];
  const { description } = formatEmail(planNotification(findOwnerDecisions(issues), []));
  assert.match(description, /comment on it with just the letter/);
  assert.match(description, /Twice a day/);
  assert.doesNotMatch(description, /claude/i);
  const src = require('fs').readFileSync(new URL('../../scripts/lib/autonomous-email-render.js', import.meta.url), 'utf8');
  assert.match(src, /comment on it with just the letter/);
  assert.doesNotMatch(src, /reply on it with your pick/);
});

test('the drain script: dry run acts on nothing, apply writes the card then the comment', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const calls = [];
  const cards = { 'BRO-6110': issue(B6110_OPEN, [c('A', '19:01')], { id: 'u1', identifier: 'BRO-6110', title: 'DECISION NEEDED: Cyrus?' }) };
  const linear = {
    listOpenIssuesWithDescriptions: async () => Object.values(cards),
    getIssue: async (id) => cards[id],
    getTeam: async () => ({ states: { nodes: [{ id: 'todo', name: 'Todo', type: 'unstarted' }] } }),
    createComment: async (id, body) => calls.push(['comment', id, body]),
    updateIssue: async (id, input) => calls.push(['update', id, input]),
  };
  const now = () => new Date('2026-10-24T20:00:00Z');
  const dry = await main([], { linear, now });
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(dry.dispatch, ['BRO-6110']);
  assert.equal(calls.length, 0);
  const live = await main(['--apply'], { linear, now });
  assert.deepEqual(live.dispatch, ['BRO-6110']);
  assert.deepEqual(calls.map((x) => x[0]), ['update', 'comment']);
  assert.match(calls[1][2], /^Owner answered: Option A/);
  assert.equal(calls[0][2].stateId, 'todo');
  assert.equal(calls[0][2].priority, 2);
  assert.equal(calls[0][2].title, 'Cyrus?');
});

test('short attempts that are not picks are questioned; discussion and session notes are not', () => {
  const card = parseDecisionDescription(B6111);
  for (const body of ['both', 'neither', 'A and B', 'the first one', 'no', 'C']) assert.equal(reply.parseReply(body, card).kind, 'unclear', body);
  for (const body of ['There are some things that only can be done on the mac. So we should keep it for cards that need it?', 'Working on it', 'Done.']) {
    assert.equal(reply.parseReply(body, card).kind, 'ignore', body);
  }
  // the real owner notes on BRO-6111 and BRO-6112 are discussion: no canned question on top of them
  assert.equal(plan(issue(B6111, [c('There are some things that only can be done on the mac. So we should keep it for cards/work that needs it, but default to using Cloud unless the mac is needed?', '19:02')])).action, 'skip');
  assert.equal(plan(issue(B6112, [c('Didn\u2019t I do this already? Not all of them, but the ones Claude thought was safe', '19:17')])).action, 'skip');
});

test('a later long note does not hide the owner A', () => {
  const p = plan(issue(B6111, [c('A', '10:00'), c('Session note: I looked into the options at length and here is a lot more detail. '.repeat(4), '10:05')]));
  assert.equal(p.action, 'needs-session');
});

test('a reply older than a week is not acted on', () => {
  const old = reply.planReply(issue(B6111, [{ id: 'o', body: 'A', createdAt: '2026-09-01T10:00:00.000Z' }]), { date: DATE, nowMs: Date.parse('2026-10-24T20:00:00Z'), verifyCommand, unfitReason: () => null });
  assert.deepEqual([old.action, old.why], ['skip', 'reply-too-old']);
});

test('keys and spend written as ENV_NAMES or phrases still need the owner', () => {
  const mk = (opt) => parseDecisionDescription(`DECISION NEEDED: q?\nOption A - ${opt}: up / down\nOption B - Leave it: none / none`);
  for (const opt of ['Add RESEND_API_KEY to Vercel', 'Add BRIGHTDATA_API_KEY', 'Use Bright Data', 'Rescore all 500 reviews with Opus', 'Enable the paid plan']) {
    assert.ok(reply.ownerOnlyReason(mk(opt), 'A'), opt);
  }
});

test('drain: the card is written before the Owner answered comment; label stays unless dispatched', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const calls = [];
  const label = { id: 'l1', name: 'awaiting-owner' };
  const cards = { 'BRO-6112': issue(B6112, [c('A', '19:01')], { id: 'u2', identifier: 'BRO-6112', labels: { nodes: [label] } }) };
  const linear = {
    listOpenIssuesWithDescriptions: async () => Object.values(cards),
    getIssue: async (id) => cards[id],
    getTeam: async () => ({ states: { nodes: [{ id: 'todo', name: 'Todo', type: 'unstarted' }] } }),
    createComment: async (id, body) => calls.push(['comment', body]),
    updateIssue: async (id, input) => calls.push(['update', input]),
  };
  const live = await main(['--apply'], { linear, now: () => new Date('2026-10-24T20:00:00Z') });
  assert.deepEqual(live['owner-only'], ['BRO-6112']);
  assert.deepEqual(calls.map((x) => x[0]), ['update', 'comment']);
  assert.equal(calls[0][1].labelIds, undefined);
  assert.equal(calls[0][1].stateId, undefined);
  assert.match(calls[1][1], /has to be done by you/);
});

const approvalLabel = { id: 'approval-label', name: 'awaiting-owner' };
const otherLabel = { id: 'other-label', name: 'design' };
const approvalIssue = (comments, extra = {}) => issue('Review the attached screenshots.', comments, {
  id: 'approval-id', identifier: 'BRO-APPROVAL', title: 'Updated show card',
  labels: { nodes: [approvalLabel, otherLabel] }, ...extra,
});
const approvalRequest = () => c('Waiting on your approval: 3 visual-qa crops attached above.', '10:00');

test('awaiting-owner: yes/approved unblock an approval without a decision line or options', () => {
  for (const body of ['yes', 'Yes!', '**approved**', 'approve', 'yep', 'yeah', 'go ahead', 'do it']) {
    const p = plan(approvalIssue([approvalRequest(), c(body, '10:05')]));
    assert.equal(p.action, 'approve', body);
    assert.equal(p.comment.body, body);
  }
});

test('awaiting-owner: a no-type reply keeps the owner words for the acknowledgement', () => {
  for (const body of ['no', 'No.', 'nope', 'nah', 'declined', 'reject', 'rejected', 'No, make the text larger.', 'not approved', 'do not ship', 'hold off', 'wait', 'not yet', "I don't approve"]) {
    const p = plan(approvalIssue([approvalRequest(), c(body, '10:05')]));
    assert.equal(p.action, 'decline', body);
    assert.equal(p.comment.body, body);
    assert.equal(plan(approvalIssue([approvalRequest(), c('yes', '10:03'), c(body, '10:05')])).action, 'decline', body);
  }
});

test('approval replies require the label, current request, open card and a clear answer', () => {
  for (const body of ['Working on it', 'Done.', 'No issues found', 'yes, but change the layout', 'approved https://example.test', 'yes\nVERIFY: something', 'A', '']) {
    assert.equal(plan(approvalIssue([approvalRequest(), c(body, '10:05')])).action, 'skip', body);
  }
  const cases = [
    approvalIssue([c('yes', '10:05')], { labels: { nodes: [otherLabel] } }),
    approvalIssue([c('yes', '09:55'), approvalRequest()]),
    approvalIssue([c('no', '09:55'), approvalRequest()]),
    approvalIssue([c('yes', '10:05')], { state: { type: 'completed', name: 'Done' } }),
    approvalIssue([c('yes', '10:05')], { state: { type: 'canceled', name: 'Canceled' } }),
    approvalIssue([c('yes', '10:05'), c('**Owner decision** (answered by the owner through the email link)', '10:10')]),
  ];
  for (const value of cases) assert.equal(plan(value).action, 'skip');
  assert.equal(reply.planReply(approvalIssue([c('yes', '10:05')]), {
    date: '2026-11-01', nowMs: Date.parse('2026-11-01T20:00:00Z'),
  }).why, 'reply-too-old');
  // A labeled card with lettered options must still use the decision path.
  assert.equal(plan(approvalIssue([c('yes', '10:05')], { description: B6111 })).action, 'needs-session');
});

test('approval replies: newer qualified answers cannot fall back to an earlier yes', () => {
  for (const body of ['yes, but change the layout', 'no further approval until the screenshots are fixed', 'approved\nif you fix the layout']) {
    const p = plan(approvalIssue([approvalRequest(), c('yes', '10:05'), c(body, '10:10')]));
    assert.deepEqual(p, { action: 'skip', why: 'unclear-approval-reply' });
  }
  assert.equal(plan(approvalIssue([approvalRequest(), c('yes', '10:05'), c('Session note: ready for review.', '10:10')])).action, 'approve');
});

test('approval replies do not replace signed visual authorization', () => {
  const p = plan(approvalIssue([approvalRequest(), c('yes', '10:05')], {
    description: `VISUAL-APPROVAL: patch=${'a'.repeat(64)} verdict=${'b'.repeat(64)} hold=visual-hold/bro-6180-visual`,
  }));
  assert.deepEqual(p, { action: 'skip', why: 'signed-visual-approval' });
});

function approvalClient(cards) {
  const calls = [];
  const linear = {
    listOpenIssuesWithDescriptions: async () => Object.values(cards),
    getIssue: async (id) => structuredClone(cards[id]),
    getTeam: async () => { throw new Error('approval-only runs need no Todo state'); },
    createComment: async (id, body) => {
      calls.push(['comment', id, body]);
      Object.values(cards).find((card) => card.id === id).comments.nodes.push({
        id: `ack-${calls.length}`, body, createdAt: '2026-10-24T20:00:00Z',
      });
    },
    updateIssue: async (id, input) => {
      calls.push(['update', id, input]);
      const card = Object.values(cards).find((value) => value.id === id);
      card.labels.nodes = card.labels.nodes.filter((label) => input.labelIds.includes(label.id));
    },
  };
  return { linear, calls };
}

test('approval drain: dry run is read-only; yes removes only the label and records the words', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const card = approvalIssue([approvalRequest(), c('approved', '10:05')]);
  const cards = { [card.identifier]: card };
  const { linear, calls } = approvalClient(cards);
  const deps = { linear, now: () => new Date('2026-10-24T20:00:00Z') };
  const dry = await main([], deps);
  assert.deepEqual(dry.approve, [card.identifier]);
  assert.equal(calls.length, 0);
  const live = await main(['--apply'], deps);
  assert.deepEqual(live.approve, [card.identifier]);
  assert.deepEqual(calls.map((call) => call[0]), ['update', 'comment']);
  assert.match(calls[1][2], /^Owner answered: approved/);
  assert.match(calls[1][2], /"approved"/);
  assert.deepEqual(calls[0][2], { labelIds: [otherLabel.id] });
  await main(['--apply'], deps);
  assert.equal(calls.length, 2, 'second run does not repeat the acknowledgement');
  card.labels.nodes.push(approvalLabel);
  await main(['--apply'], deps);
  assert.equal(calls.length, 2, 'manually re-labeling does not replay a handled approval');
});

test('approval drain: no records the reason once and leaves all card fields alone', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const card = approvalIssue([approvalRequest(), c('No, make the text larger.', '10:05')]);
  const { linear, calls } = approvalClient({ [card.identifier]: card });
  const deps = { linear, now: () => new Date('2026-10-24T20:00:00Z') };
  const live = await main(['--apply'], deps);
  assert.deepEqual(live.decline, [card.identifier]);
  assert.deepEqual(calls.map((call) => call[0]), ['comment']);
  assert.match(calls[0][2], /^Owner declined:/);
  assert.match(calls[0][2], /"No, make the text larger\."/);
  assert.deepEqual(card.labels.nodes, [approvalLabel, otherLabel]);
  await main(['--apply'], deps);
  assert.equal(calls.length, 1);
});

test('approval drain: rechecks the label and latest request before writing', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  for (const change of [
    (card) => { card.labels.nodes = [otherLabel]; },
    (card) => { card.comments.nodes.push(c('Waiting on your approval: new crops.', '10:10')); },
    (card) => { card.comments.nodes[1].body = 'no'; },
    (card) => { card.state = { type: 'completed' }; },
  ]) {
    const card = approvalIssue([approvalRequest(), c('yes', '10:05')]);
    const { linear, calls } = approvalClient({ [card.identifier]: card });
    let reads = 0;
    const getIssue = linear.getIssue;
    linear.getIssue = async (id) => { if (++reads === 2) change(card); return getIssue(id); };
    const result = await main(['--apply'], { linear, now: () => new Date('2026-10-24T20:00:00Z') });
    assert.equal(result.skipped['changed-since-read'], 1);
    assert.equal(calls.length, 0);
  }
});

test('approval drain: preserves labels added since the initial scan', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const card = approvalIssue([approvalRequest(), c('yes', '10:05')]);
  const { linear, calls } = approvalClient({ [card.identifier]: card });
  let reads = 0;
  const getIssue = linear.getIssue;
  linear.getIssue = async (id) => {
    if (++reads === 2) card.labels.nodes.push({ id: 'new-label', name: 'new' });
    return getIssue(id);
  };
  await main(['--apply'], { linear, now: () => new Date('2026-10-24T20:00:00Z') });
  assert.deepEqual(calls[0][2], { labelIds: [otherLabel.id, 'new-label'] });
});

test('approval drain: a failed label removal posts no acknowledgement and retries next run', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const card = approvalIssue([approvalRequest(), c('yes', '10:05')]);
  const { linear, calls } = approvalClient({ [card.identifier]: card });
  const update = linear.updateIssue;
  linear.updateIssue = async () => { throw new Error('label write failed'); };
  const deps = { linear, now: () => new Date('2026-10-24T20:00:00Z') };
  try {
    const failed = await main(['--apply'], deps);
    assert.deepEqual(failed.failed, [card.identifier]);
    assert.equal(calls.length, 0);
    assert.deepEqual(card.labels.nodes, [approvalLabel, otherLabel]);
    linear.updateIssue = update;
    const retried = await main(['--apply'], deps);
    assert.deepEqual(retried.approve, [card.identifier]);
    assert.deepEqual(calls.map((call) => call[0]), ['update', 'comment']);
  } finally {
    process.exitCode = 0;
  }
});

test('approval drain: reports an acknowledgement failure after applying the approval', async () => {
  const { main } = require('../../scripts/linear-decision-reply-drain.js');
  const card = approvalIssue([approvalRequest(), c('yes', '10:05')]);
  const { linear, calls } = approvalClient({ [card.identifier]: card });
  linear.createComment = async () => { throw new Error('comment write failed'); };
  const deps = { linear, now: () => new Date('2026-10-24T20:00:00Z') };
  try {
    assert.deepEqual((await main(['--apply'], deps)).failed, [card.identifier]);
    assert.deepEqual(calls.map((call) => call[0]), ['update']);
    assert.deepEqual(card.labels.nodes, [otherLabel]);
    assert.equal(card.comments.nodes.at(-1).body, 'yes', 'the original owner words remain recorded');
  } finally {
    process.exitCode = 0;
  }
});
