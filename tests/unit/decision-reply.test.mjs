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
