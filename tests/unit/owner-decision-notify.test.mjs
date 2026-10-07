import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractDecisionQuestion, findOwnerDecisions, planNotification, formatEmail, MAX_LISTED,
} = require('../../scripts/lib/owner-decision-notify.js');
const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
const { CONDITION_KEY } = require('../../scripts/notify-owner-decisions.js');

test('extracts a real DECISION NEEDED line, bold or plain', () => {
  assert.equal(extractDecisionQuestion('Intro\nDECISION NEEDED: Ship the paywall now?\nmore'), 'Ship the paywall now?');
  assert.equal(extractDecisionQuestion('**DECISION NEEDED:** Keep West End pages?'), 'Keep West End pages?');
  assert.equal(extractDecisionQuestion('- DECISION NEEDED: Pick a vendor'), 'Pick a vendor');
});

test('ignores template placeholders, code, and mid-sentence mentions', () => {
  assert.equal(extractDecisionQuestion('DECISION NEEDED: <what, one sentence, plain English>'), null);
  assert.equal(extractDecisionQuestion('```\nDECISION NEEDED: Ship it?\n```'), null);
  assert.equal(extractDecisionQuestion('Add a `DECISION NEEDED: x` line'), null);
  assert.equal(extractDecisionQuestion('The hook checks for DECISION NEEDED: blocks at the bottom'), null);
  assert.equal(extractDecisionQuestion('Owner must decide whether to ship.'), null);
  assert.equal(extractDecisionQuestion(null), null);
});

test('skips stub and already-answered lines, accepts heading/numbered/(owner) forms', () => {
  assert.equal(extractDecisionQuestion('DECISION NEEDED: none — no pending decision'), null);
  assert.equal(extractDecisionQuestion('DECISION NEEDED: No decision needed.'), null);
  assert.equal(extractDecisionQuestion('DECISION NEEDED: answered 10/03, chose A'), null);
  assert.equal(extractDecisionQuestion('## DECISION NEEDED: Keep the paywall?'), 'Keep the paywall?');
  assert.equal(extractDecisionQuestion('1. DECISION NEEDED: Pick a vendor?'), 'Pick a vendor?');
  assert.equal(extractDecisionQuestion('DECISION NEEDED (owner): Raise the cap?'), 'Raise the cap?');
  assert.equal(extractDecisionQuestion('DECISION NEEDED: Nothingness tour, book it?'), 'Nothingness tour, book it?');
});

test('findOwnerDecisions sorts most urgent first, then oldest; no priority last', () => {
  const issues = [
    { identifier: 'BRO-10', description: 'DECISION NEEDED: none?', priority: 0, createdAt: '2026-01-01' },
    { identifier: 'BRO-11', description: 'DECISION NEEDED: low?', priority: 4, createdAt: '2026-01-02' },
    { identifier: 'BRO-12', description: 'DECISION NEEDED: urgent new?', priority: 1, createdAt: '2026-03-01' },
    { identifier: 'BRO-13', description: 'DECISION NEEDED: urgent old?', priority: 1, createdAt: '2026-02-01' },
  ];
  assert.deepEqual(findOwnerDecisions(issues).map((d) => d.identifier), ['BRO-13', 'BRO-12', 'BRO-11', 'BRO-10']);
});

test('findOwnerDecisions takes marked or awaiting-owner cards, oldest first', () => {
  const issues = [
    { identifier: 'BRO-2', title: 'b', description: 'DECISION NEEDED: B?', createdAt: '2026-10-02' },
    { identifier: 'BRO-1', title: 'a', description: 'no marker', createdAt: '2026-10-01', labels: { nodes: [{ name: 'awaiting-owner' }] } },
    { identifier: 'BRO-3', title: 'c', description: 'needs owner approval', createdAt: '2026-09-01' },
  ];
  const got = findOwnerDecisions(issues);
  assert.deepEqual(got.map((d) => d.identifier), ['BRO-1', 'BRO-2']);
  assert.equal(got[0].question, null);
  assert.equal(got[1].question, 'B?');
});

test('planNotification announces each card once and prunes closed ones', () => {
  const ds = ['BRO-1', 'BRO-2', 'BRO-3'].map((identifier) => ({ identifier, title: identifier }));
  const first = planNotification(ds, []);
  assert.equal(first.fresh.length, 3);
  assert.deepEqual(first.nextNotified, ['BRO-1', 'BRO-2', 'BRO-3']);

  const second = planNotification(ds, first.nextNotified);
  assert.equal(second.fresh.length, 0);

  // BRO-2 answered (marker removed), BRO-9 is old notified state, BRO-4 is new.
  const third = planNotification([ds[0], ds[2], { identifier: 'BRO-4', title: 'd' }], ['BRO-1', 'BRO-2', 'BRO-3', 'BRO-9']);
  assert.deepEqual(third.fresh.map((d) => d.identifier), ['BRO-4']);
  assert.deepEqual(third.nextNotified, ['BRO-1', 'BRO-3', 'BRO-4']);
});

test('only the listed cards are marked told when more than the cap are new', () => {
  const ds = Array.from({ length: MAX_LISTED + 4 }, (_, i) => ({ identifier: `BRO-${100 + i}`, title: `t${i}` }));
  const plan = planNotification(ds, []);
  assert.equal(plan.listed.length, MAX_LISTED);
  assert.equal(plan.more, 4);
  assert.equal(plan.nextNotified.length, MAX_LISTED);
  assert.match(formatEmail(plan).description, /\+4 more/);
});

test('email is plain English with the question and link', () => {
  const plan = planNotification([{ identifier: 'BRO-1', title: 'Paywall', question: 'Ship the paywall now?', url: 'https://linear.app/x/BRO-1' }], []);
  const { title, description } = formatEmail(plan);
  assert.equal(title, '1 new decision is waiting on you');
  assert.match(description, /Ship the paywall now\?/);
  assert.match(description, /https:\/\/linear\.app\/x\/BRO-1/);
  assert.doesNotMatch(description, /—/);
});

test('the condition key is on the owner page-worthy allowlist', () => {
  assert.equal(CONDITION_KEY, 'owner-decisions:new');
  assert.equal(isPageWorthy(CONDITION_KEY), true);
});
