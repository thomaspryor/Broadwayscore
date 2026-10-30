// BRO-6654: Mac-only owner tasks. A DECISION NEEDED card with "Owner step N:"
// lines is emailed as a task with Done / could-not-do-it buttons, and a fresh
// Done tap sends the card to the front of the cloud worker's queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.CODEX_TRUST_LADDER_DISABLED = '1';
const link = require('../../src/lib/owner-decision-link.js');
const { buildDecisionEmail } = require('./owner-decision-email.js');
const pick = require('./cloud-worker-pick.js');

const SECRET = 'test-secret';
const NOW = Date.parse('2026-10-30T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const TASK = [
  'DECISION NEEDED: Turn off tracking in the App Store privacy answers',
  'Why this is your call: Apple has no API for the privacy questionnaire, so only a signed-in person can change it.',
  'Owner step 1: Open appstoreconnect.apple.com on your Mac and sign in.',
  'Owner step 2: Open Broadway Scorecard, then App Privacy.',
  'Owner step 3: Set "Used for tracking" to No and press Publish.',
  '',
  '## Acceptance criteria',
  '`node --test scripts/lib/example.test.mjs` passes.',
].join('\n');

test('Owner step lines make the card a task with Done / could-not buttons', () => {
  const block = link.parseDecisionBlock(TASK);
  assert.equal(block.task, true);
  assert.deepEqual(block.steps.length, 3);
  assert.match(block.steps[2], /Used for tracking/);
  assert.deepEqual(link.answerChoices(TASK).map((c) => c.key), ['done', 'blocked']);
});

test('a plain "Step 1:" plan on a decision card stays a decision', () => {
  const desc = 'DECISION NEEDED: Ship the new badge?\nStep 1: build it\nStep 2: test it';
  assert.equal(link.parseDecisionBlock(desc).task, false);
  assert.deepEqual(link.answerChoices(desc).map((c) => c.key), ['approve', 'reject']);
});

test('real A/B options win over Owner step lines', () => {
  const desc = `${TASK}\nOption A — Do it now: fast / costs a tap\nOption B — Wait: slow / nothing`;
  assert.equal(link.parseDecisionBlock(desc).task, false);
  assert.deepEqual(link.answerChoices(desc).map((c) => c.key), ['a', 'b']);
});

test('the task email lists the steps, says Done, and has no em dashes', () => {
  const { subject, html } = buildDecisionEmail({
    decision: { identifier: 'BRO-1', title: 'App privacy', url: 'https://linear.app/x/issue/BRO-1', question: 'Turn off tracking in the App Store privacy answers' },
    description: TASK, secret: SECRET, now: NOW,
  });
  assert.equal(subject, 'Task for you: Turn off tracking in the App Store privacy answers');
  assert.match(html, /<ol[^>]*>[\s\S]*appstoreconnect\.apple\.com[\s\S]*Publish/);
  assert.match(html, /Done, I did it/);
  assert.match(html, /I could not do it/);
  assert.match(html, /Why Claude cannot do this itself/);
  assert.doesNotMatch(html, /[—–]/);
  assert.match(html, /o=done/);
});

test('an ordinary decision email is unchanged', () => {
  const { subject } = buildDecisionEmail({
    decision: { identifier: 'BRO-2', title: 'Badge', question: 'Ship the new badge?' },
    description: 'DECISION NEEDED: Ship the new badge?', secret: SECRET, now: NOW,
  });
  assert.equal(subject, 'Decision needed: Ship the new badge?');
});

// ── the worker picks the card back up ──────────────────────────────────────
const doneComment = (msAgo, choice = 'Done, I did it') => ({
  body: link.buildAnswerComment({ choiceLabel: choice, text: '', ref: 'abc', now: new Date(NOW - msAgo) }),
  createdAt: at(msAgo),
});
const pausedReport = (msAgo) => ({ body: '**Session report (paused)**\n\nWaiting on the owner to change the App Store privacy setting.', createdAt: at(msAgo) });
const card = (comments, over = {}) => ({
  identifier: 'BRO-900', title: 'App privacy', description: TASK.replace('DECISION NEEDED:', 'ANSWERED:'), priority: 2,
  state: { name: 'Todo', type: 'unstarted' }, createdAt: at(10 * 24 * HOUR), updatedAt: at(5 * MIN),
  comments: { nodes: comments }, ...over,
});

test('a fresh Done tap skips the idle wait and the pause cooldown, and goes first', () => {
  const comments = [pausedReport(2 * HOUR), doneComment(5 * MIN)];
  const c = card(comments);
  assert.equal(pick.isOwnerTaskResume(c, NOW), true);
  assert.equal(pick.skipReason(c, NOW), null);
  assert.equal(pick.pausedHistorySkipReason(comments, NOW, { priority: 2 }), null);
  const other = { ...card([]), identifier: 'BRO-10', priority: 1, updatedAt: at(7 * HOUR), comments: { nodes: [] } };
  assert.equal(pick.pickCloudCard([other, c], { nowMs: NOW }).pick.identifier, 'BRO-900');
});

test('"I could not do it", an old tap, or a later human comment does not fast-track', () => {
  assert.equal(pick.isOwnerTaskResume(card([doneComment(5 * MIN, 'I could not do it')]), NOW), false);
  assert.equal(pick.isOwnerTaskResume(card([doneComment(49 * HOUR)]), NOW), false);
  const later = { body: 'Actually hold off, I need to redo it.', createdAt: at(1 * MIN) };
  assert.equal(pick.isOwnerTaskResume(card([doneComment(5 * MIN), later]), NOW), false);
  assert.equal(pick.skipReason(card([doneComment(5 * MIN, 'I could not do it')]), NOW), 'recent-activity');
});

test('a machine receipt after the tap does not hide it', () => {
  const receipt = { body: 'Dispatched to a cloud worker', createdAt: at(1 * MIN) };
  assert.equal(pick.isOwnerTaskResume(card([doneComment(5 * MIN), receipt]), NOW), true);
});
