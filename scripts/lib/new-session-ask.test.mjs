import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { newSessionAsk } = createRequire(import.meta.url)('./new-session-ask.js');

test('real BRO-7741 closing is blocked', () => {
  const t = 'The fix is not live yet.\nYou need to: start a new session and tell it to finish and release BRO-7741.';
  assert.equal(newSessionAsk(t).block, true);
});
test('phrase class is blocked', () => {
  for (const t of ['Please start a fresh session.', 'Open a new session and tell it to retry.', 'You can start another session to finish this.',
    'Tell a new session to pick it up.', 'You should open a new chat.', 'Spin up a fresh worker for the rest.']) {
    assert.equal(newSessionAsk(t).block, true, t);
  }
});
test('rules, negations and quotes are not asks', () => {
  for (const t of ['Never ask the owner to start a new session.', 'I did not tell you to start a new session.',
    'The gate now blocks "start a new session" in closings.', 'The `open a fresh session` phrase is banned.',
    'I started a new session myself and handed it the card.', 'This session is done.', 'A fresh session picks up the next sprint via the card.']) {
    assert.equal(newSessionAsk(t).block, false, t);
  }
});

test('BRO-7918 review: new tab and a worker describing its own create_session are not asks', () => {
  assert.equal(newSessionAsk('Open a new tab to see the preview.').block, false);
  assert.equal(newSessionAsk('I will start a new worker session for BRO-9 now.').block, false);
  assert.equal(newSessionAsk('You should start a new session and tell it to finish this.').block, true);
});
