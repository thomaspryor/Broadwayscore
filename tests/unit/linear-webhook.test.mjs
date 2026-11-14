// BRO-6715: the Linear webhook only acts on a signed, fresh, human-looking reply on a card waiting on the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const w = require('../../src/lib/linear-webhook.js');
const SECRET = 'whsec-test';
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const ID = '11111111-2222-3333-4444-555555555555';
const comment = (body) => ({ type: 'Comment', action: 'create', webhookTimestamp: Date.now(), data: { body, issueId: ID } });

test('signature: right secret passes, tampered body, wrong secret, junk and missing header fail', () => {
  const raw = JSON.stringify(comment('A'));
  assert.equal(w.verifySignature(raw, sign(raw), SECRET), true);
  assert.equal(w.verifySignature(raw + ' ', sign(raw), SECRET), false);
  assert.equal(w.verifySignature(raw, sign(raw), 'other'), false);
  assert.equal(w.verifySignature(raw, 'zz', SECRET), false);
  assert.equal(w.verifySignature(raw, null, SECRET), false);
  assert.equal(w.verifySignature(raw, sign(raw), ''), false);
});

test('freshness: a replay older than a minute is refused', () => {
  assert.equal(w.fresh({ webhookTimestamp: Date.now() - 5000 }), true);
  assert.equal(w.fresh({ webhookTimestamp: Date.now() - 5 * 60000 }), false);
  assert.equal(w.fresh({}), false);
});

test('replyCandidate: owner words pass; machine notes, long reports, edits and other types do not', () => {
  assert.equal(w.replyCandidate(comment('Option A.\n\nStore all past and future data points')), ID);
  assert.equal(w.replyCandidate(comment('yes')), ID);
  for (const b of ['**Session report (paused)**\n\nBuilt it', 'Claimed by https://x', 'Emailed the owner this decision with answer buttons.', '**Owner decision** (answered by the owner through the email link)', 'Owner answered: Option A', '[auto-fix-attempted:fail] x', '', 'x'.repeat(2000)]) {
    assert.equal(w.replyCandidate(comment(b)), null, b.slice(0, 30));
  }
  assert.equal(w.replyCandidate({ ...comment('A'), action: 'update' }), null);
  assert.equal(w.replyCandidate({ ...comment('A'), type: 'Issue' }), null);
  assert.equal(w.replyCandidate({ type: 'Comment', action: 'create', data: { body: 'A', issueId: 'not-a-uuid' } }), null);
});

test('waitsOnOwner: live decision or label yes; answered, closed or plain cards no', () => {
  const lab = [{ name: 'awaiting-owner' }];
  assert.equal(w.waitsOnOwner({ description: 'DECISION NEEDED: pick?', labels: { nodes: [] }, state: { type: 'started' } }), true);
  assert.equal(w.waitsOnOwner({ description: 'x', labels: { nodes: lab }, state: { type: 'unstarted' } }), true);
  assert.equal(w.waitsOnOwner({ description: 'x', labels: { nodes: [] }, state: { type: 'unstarted' } }), false);
  assert.equal(w.waitsOnOwner({ description: 'DECISION NEEDED: pick?', labels: { nodes: [] }, state: { type: 'completed' } }), false);
  assert.equal(w.waitsOnOwner(null), false);
});

test('waitsOnOwner: a second open question survives an ANSWERED line; prose mentions and heading form behave', () => {
  const w = require('../../src/lib/linear-webhook.js');
  const open = { state: { type: 'unstarted' } };
  assert.equal(w.waitsOnOwner({ ...open, description: 'ANSWERED by the owner (x).\n\nDECISION NEEDED: second question?' }), true);
  assert.equal(w.waitsOnOwner({ ...open, description: 'We discussed the DECISION NEEDED process in prose.' }), false);
  assert.equal(w.waitsOnOwner({ ...open, description: '## DECISION NEEDED (owner)\n\nWhich?' }), true);
  assert.equal(w.waitsOnOwner({ state: { type: 'completed' }, labels: { nodes: [{ name: 'awaiting-owner' }] }, description: '' }), false);
  assert.equal(w.replyCandidate({ type: 'Comment', action: 'create', data: { body: 'Visual change approved by the owner. The lander will ship it.', issueId: '0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b' } }), null);
});
