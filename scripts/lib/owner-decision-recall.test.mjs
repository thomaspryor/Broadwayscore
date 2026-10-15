import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findPriorAnswers, splitAnswered, answerOf } = require('./owner-decision-recall.js');

const cards = [
  { identifier: 'BRO-3624', title: 'Email pop-up: keep, change or remove?', state: { type: 'canceled' }, canceledAt: '2026-10-11T09:00:00Z',
    description: 'Owner question about the email signup pop-up.',
    comments: { nodes: [{ body: 'Owner answered: keep the current pop-up.', createdAt: '2026-10-11T09:00:00Z' }] } },
  { identifier: 'BRO-4616', title: 'Sign-in sheet after first save', state: { type: 'canceled' },
    comments: { nodes: [{ body: 'Owner decision: Option A.', createdAt: '2026-10-04T10:00:00Z' }] } },
  { identifier: 'BRO-100', title: 'Email pop-up copy typo', state: { type: 'completed' }, comments: { nodes: [{ body: 'fixed', createdAt: '2026-09-01T00:00:00Z' }] } },
  { identifier: 'BRO-200', title: 'Email pop-up still open', state: { type: 'started' }, comments: { nodes: [{ body: 'Owner answered: yes', createdAt: '2026-10-01T00:00:00Z' }] } },
];

test('email pop-up topic resolves to the BRO-3624 answer of 2026-10-11', () => {
  const found = findPriorAnswers('Email pop-up friction: users dismiss the signup popup', cards);
  assert.equal(found.length, 1);
  assert.equal(found[0].identifier, 'BRO-3624');
  assert.equal(found[0].date, '2026-10-11');
  assert.match(found[0].text, /keep the current pop-up/);
});

test('sign-in sheet topic resolves to BRO-4616', () => {
  assert.equal(findPriorAnswers('sign-in sheet after first save', cards)[0].identifier, 'BRO-4616');
});

test('closed cards without an owner answer, and open cards, are not answers', () => {
  assert.equal(answerOf(cards[2]), null);
  assert.equal(answerOf(cards[3]), null);
});

test('unrelated topic finds nothing', () => {
  assert.deepEqual(findPriorAnswers('Search returns no results for tony awards', cards), []);
});

test('friction analyzer filter files nothing new for an answered topic', () => {
  const issues = [{ title: 'Email popup dismissed quickly on mobile' }, { title: 'Ticket link broken on closed shows' }];
  const { fresh, answered } = splitAnswered(issues, cards);
  assert.deepEqual(fresh.map((i) => i.title), ['Ticket link broken on closed shows']);
  assert.equal(answered[0].prior[0].identifier, 'BRO-3624');
});
