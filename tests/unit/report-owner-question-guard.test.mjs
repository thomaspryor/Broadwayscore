import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkHiddenOwnerQuestion } = require('../../scripts/lib/report-owner-question-guard.js');

const BLOCK = 'DECISION NEEDED: Add the Liberation tour to the site?\nWhy this is your call: public listing.\nOption A - add: more coverage / unconfirmed\nOption B - wait: safe / later\nMy recommendation: B because Wikipedia does not confirm it.\nDefault: wait.';

test('paused report naming an owner decision with no block is hidden', () => {
  for (const summary of ['Paused: owner decision needed on the tour.', 'Waiting on the owner to pick.', 'This needs the owner.']) {
    const r = checkHiddenOwnerQuestion({ status: 'paused', summary });
    assert.equal(r.hidden, true, summary);
    assert.match(r.reason, /DECISION NEEDED:/);
  }
});

test('the same report with a real block passes', () => {
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: `Owner decision needed.\n${BLOCK}` }).hidden, false);
});

test('a block already on the card satisfies the guard', () => {
  assert.equal(checkHiddenOwnerQuestion({ status: 'blocked', summary: 'Still waiting on the owner.', description: BLOCK }).hidden, false);
});

test('placeholder or settled blocks do not count', () => {
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: 'Owner decision needed.\nDECISION NEEDED: <what, one sentence, plain English>' }).hidden, true);
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: 'Owner decision needed.\nDECISION NEEDED: none' }).hidden, true);
});

test('negated mentions, unrelated reports and done reports are not blocked', () => {
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: 'This is not an owner decision, a worker can take it.' }).hidden, false);
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: 'Paused: CI queue is deep.' }).hidden, false);
  assert.equal(checkHiddenOwnerQuestion({ status: 'done', summary: 'Needs the owner to look at the page later.' }).hidden, false);
  assert.equal(checkHiddenOwnerQuestion({}).hidden, false);
});

test('lowercase prose "owner decision needed: ..." is not a block (the real BRO-6128 and BRO-5447 reports)', () => {
  const r128 = 'Owner decision needed: add the Liberation national tour as a tracked tour of liberation-2025? Wikipedia does not confirm the launch.';
  const r5447 = 'Not fixable without an owner call. QUESTION FOR OWNER: discard or send late? Recommendation: discard.';
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: r128 }).hidden, true);
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: r5447 }).hidden, true);
  assert.equal(checkHiddenOwnerQuestion({ status: 'paused', summary: r128 + '\n' + BLOCK }).hidden, false);
});

test('verification text is checked too', () => {
  assert.equal(checkHiddenOwnerQuestion({ status: 'in-review', summary: 'ok', verification: 'needs the owner approval' }).hidden, true);
});

test('cmdReport refuses (exit 6) before posting a comment', async () => {
  process.env.LINEAR_API_KEY = 'test-key';
  const linear = require('../../scripts/lib/linear-client.js');
  const calls = [];
  const orig = { getIssue: linear.getIssue, createComment: linear.createComment };
  linear.getIssue = async () => ({ id: 'x', identifier: 'BRO-1', description: '', state: { name: 'In Progress' } });
  linear.createComment = async () => { calls.push('comment'); };
  const origExit = process.exit;
  process.exit = (c) => { throw new Error(`exit:${c}`); };
  const origErr = console.error; console.error = () => {};
  try {
    const { cmdReport } = require('../../scripts/linear-session.js');
    await assert.rejects(cmdReport({ issue: 'BRO-1', status: 'paused', summary: 'Owner decision needed.' }), /exit:6/);
    assert.deepEqual(calls, []);
  } finally {
    process.exit = origExit; console.error = origErr; Object.assign(linear, orig);
  }
});
