import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { loadScheduledSendHistory, planScheduledSend } = createRequire(import.meta.url)('../../scripts/lib/scheduled-send-guard.js');

const recipient = 'owner@example.com';
const now = new Date('2026-11-02T22:00:00Z');
const email = (subject, overrides = {}) => ({ to: [recipient], subject, created_at: '2026-11-02 11:00:00+00', ...overrides });
const history = (emails = [], dayKey = '2026-11-02') => ({ emails, dayKey });
const plan = (sender, subject, sent = history()) => planScheduledSend({ sender, subject, recipient, history: sent });

test('opening digest skips same-day reruns even when its content and subject change', () => {
  const sent = history([email('1 broadcast-ready · Nov 2')]);
  assert.equal(plan('opening-digest', '2 needs help · Nov 2', sent).alreadySent, true);
  assert.equal(plan('opening-digest', '1 broadcast-ready · Nov 2').idempotencyKey,
    plan('opening-digest', '2 needs help · Nov 2').idempotencyKey);
});

test('Reddit suppresses the repeated Moth update while preserving distinct drafts and kinds', () => {
  const subject = 'Updated Reddit post: The Moth (55/100) for r/TheWestEnd';
  const sent = history([email(subject)]);
  assert.equal(plan('reddit-post-ready', subject, sent).alreadySent, true);
  for (const other of [
    'Updated Reddit post: Medea (76/100) for r/offbroadwayNYC',
    'Reddit post ready: The Moth (55/100) for r/TheWestEnd',
    'Updated Reddit post: The Moth (56/100) for r/TheWestEnd',
  ]) {
    assert.equal(plan('reddit-post-ready', other, sent).alreadySent, false);
    assert.notEqual(plan('reddit-post-ready', subject).idempotencyKey, plan('reddit-post-ready', other).idempotencyKey);
  }
});

test('recipient and ET day scope the guard, including the 25-hour DST day', () => {
  const subject = 'Quiet week · Nov 2';
  for (const old of [
    email(subject, { to: ['someone@example.com'] }),
    email(subject, { created_at: '2026-11-02 04:59:59+00' }),
    email('Unrelated owner email'),
  ]) assert.equal(plan('opening-digest', subject, history([old])).alreadySent, false);
  assert.equal(plan('opening-digest', subject, history([email(subject, { to: 'OWNER@EXAMPLE.COM' })])).alreadySent, true);
  assert.equal(plan('opening-digest', subject, history([email(subject, { created_at: '2026-11-01 04:01:00+00' })], '2026-11-01')).alreadySent, true);
  assert.notEqual(plan('opening-digest', subject).idempotencyKey, plan('opening-digest', subject, history([], '2026-11-03')).idempotencyKey);
  assert.notEqual(plan('opening-digest', subject).idempotencyKey,
    planScheduledSend({ sender: 'opening-digest', subject, recipient: 'other@example.com', history: history() }).idempotencyKey);
});

test('history reads fail closed and cover the whole ET day with strict pagination', async () => {
  let request;
  const result = await loadScheduledSendHistory({ apiKey: 'test', recipient, now, fetchEmails: async (args) => { request = args; return []; } });
  assert.deepEqual(result, history());
  assert.equal(request.strict, true);
  assert.equal(request.ownerEmail, recipient);
  assert.ok(request.sinceMs <= Date.parse('2026-11-02T05:00:00Z'));
  await assert.rejects(loadScheduledSendHistory({ recipient, now }), /required/);
  await assert.rejects(loadScheduledSendHistory({ apiKey: 'test', recipient, now, fetchEmails: async () => { throw new Error('history incomplete'); } }), /history incomplete/);
  await assert.rejects(loadScheduledSendHistory({ apiKey: 'test', recipient, now, fetchEmails: async () => null }), /history/);
});

test('unsupported senders fail closed', () => {
  assert.throws(() => plan('unknown', 'subject'), /Unsupported/);
});
