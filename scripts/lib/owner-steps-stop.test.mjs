// BRO-7994: pins owner-steps-stop.mjs. The incident instruction blocks once; a recipe-rendered closing, a reply-only
// ask, the bypass and the kill switch allow; non-cloud sessions are never judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stopHookDecision, main, blockBudget } from './owner-steps-stop.mjs';
const require = createRequire(import.meta.url);
const { render } = require('./owner-steps.js');

const ENV = { CLAUDE_CODE_REMOTE: 'true' };
const INCIDENT = "Shipped.\nStill running: nothing.\nYou need to: In the Google console, add both broadwayscorecard.com addresses as authorized JavaScript origins on the web client starting 1084460721483-0vvpc, then tell me when you've saved.\n\nACTION NEEDED FROM YOU — add the two addresses in Google's console";

test('the incident closing blocks with the recipe pointer', () => {
  const d = stopHookDecision({ lastMessage: INCIDENT, env: ENV });
  assert.equal(d.decision, 'block');
  assert.match(d.message, /google-js-origins/);
  assert.match(d.message, /direct link/);
});

test('a closing built from the recipe passes', () => {
  const msg = `Shipped.\nStill running: nothing.\n${render('google-js-origins')}\n\nACTION NEEDED FROM YOU — follow the steps above, then reply "done"`;
  assert.equal(stopHookDecision({ lastMessage: msg, env: ENV }).decision, 'allow');
});

test('reply-only, bypass, kill switch and local sessions allow', () => {
  assert.equal(stopHookDecision({ lastMessage: 'You need to: reply "yes" on the preview.', env: ENV }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: `${INCIDENT}\nNO-OWNER-STEPS: Google gives no direct page for this setting`, env: ENV }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: INCIDENT, env: { ...ENV, OWNER_STEPS_STOP_DISABLE: '1' } }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: INCIDENT, env: {} }).decision, 'allow');
});

test('main: nudges once per distinct owner block before the blocking date, then fails open', () => {
  const stdin = JSON.stringify({ last_assistant_message: INCIDENT, transcript_path: `/tmp/os-test-${process.pid}-${Date.now()}` });
  const now = new Date('2026-11-21T12:00:00Z');
  assert.equal(blockBudget(now), 1);
  assert.equal(blockBudget(new Date('2026-11-28T00:00:00Z')), 2);
  const err = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(main(['--stop-hook'], { env: ENV, now, stdin }), 2);
    assert.equal(main(['--stop-hook'], { env: ENV, now, stdin }), 0);
  } finally { process.stderr.write = err; }
});

test('main: rewriting the owner block does not reset the budget forever (per-session cap)', async () => {
  const { SESSION_BUDGET } = await import('./owner-steps-stop.mjs');
  const tp = `/tmp/os-cap-${process.pid}-${Date.now()}`;
  const now = new Date('2026-11-21T12:00:00Z');
  const err = process.stderr.write;
  process.stderr.write = () => true;
  let blocks = 0;
  try {
    for (let i = 0; i < SESSION_BUDGET + 3; i++) {
      const msg = INCIDENT.replace('then tell me', `then (try ${i}) tell me`);
      if (main(['--stop-hook'], { env: ENV, now, stdin: JSON.stringify({ last_assistant_message: msg, transcript_path: tp }) }) === 2) blocks++;
    }
  } finally { process.stderr.write = err; }
  assert.equal(blocks, SESSION_BUDGET);
});
