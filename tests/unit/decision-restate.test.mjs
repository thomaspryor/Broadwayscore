// BRO-6539: an already-answered DECISION NEEDED is not restated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { answerState, dropAnswered, decisionCards, checkCards, main } = require('../../scripts/lib/decision-restate.js');

const ask = (at) => ({ body: 'DECISION NEEDED: pick one\nOption A — x\nOption B — y', createdAt: at });
const ownerA = (at) => ({ body: '**Owner decision** (answered by the owner through the email link, 2026-10-29 UTC)\n\nChose: Option A', createdAt: at });

test('an owner-decision comment newer than the question means answered', () => {
  const st = answerState([ask('2026-10-29T10:00:00Z'), ownerA('2026-10-29T13:48:00Z')]);
  assert.equal(st.answered, true);
  assert.match(st.answer.text, /Owner decision/);
});

test('an answer older than a re-asked question does not count; no answer is open', () => {
  assert.equal(answerState([ownerA('2026-10-29T09:00:00Z'), ask('2026-10-29T10:00:00Z')]).answered, false);
  assert.equal(answerState([ask('2026-10-29T10:00:00Z')]).answered, false);
});

test('the auto "Waiting on your approval" notice after the approval is not a new question (BRO-4303)', () => {
  const st = answerState([
    { body: 'Asked the owner to look at 3 screenshot(s).', createdAt: '2026-10-29T12:00:00Z' },
    { body: 'Visual approval ref VQA-abc', createdAt: '2026-10-29T14:33:00Z' },
    { body: 'Waiting on your approval: 3 visual-qa crops attached above.', createdAt: '2026-10-29T17:08:00Z' },
  ]);
  assert.equal(st.answered, true);
});

test('a decline does not close the question', () => {
  assert.equal(answerState([ask('2026-10-29T10:00:00Z'), { body: 'Owner declined: by replying no on 2026-10-29.', createdAt: '2026-10-29T11:00:00Z' }]).answered, false);
});

test('dropAnswered keeps open items and drops answered ones', () => {
  const comments = new Map([
    ['BRO-5646', [ask('2026-10-29T10:00:00Z'), ownerA('2026-10-29T13:48:00Z')]],
    ['BRO-5641', [ask('2026-10-29T10:00:00Z')]],
  ]);
  const { keep, dropped } = dropAnswered([{ card: 'BRO-5646' }, { card: 'BRO-5641' }], comments);
  assert.deepEqual(keep.map((i) => i.card), ['BRO-5641']);
  assert.deepEqual(dropped.map((i) => i.card), ['BRO-5646']);
});

test('decisionCards reads ids only inside DECISION NEEDED blocks', () => {
  const msg = 'Fixed BRO-1.\n\nDECISION NEEDED: BRO-5646 codex choice\nWhy this is your call: money\nOption A — x\nMy recommendation: A.\nDefault: nothing.\n\nSee BRO-9 too.';
  assert.deepEqual(decisionCards(msg), ['BRO-5646']);
});

test('main prints ALREADY ANSWERED for a message and stays quiet when nothing is', async () => {
  const lines = [];
  const msg = 'DECISION NEEDED: BRO-5646 pick\nDefault: none.';
  const listComments = async () => new Map([['BRO-5646', [ask('2026-10-29T10:00:00Z'), ownerA('2026-10-29T13:48:00Z')]]]);
  await main(['--message-stdin'], { stdin: () => msg, out: (l) => lines.push(l), listComments });
  assert.match(lines.join('\n'), /BRO-5646: ALREADY ANSWERED/);
  const quiet = [];
  await main(['--message-stdin'], { stdin: () => 'all done', out: (l) => quiet.push(l), listComments });
  assert.deepEqual(quiet, []);
  assert.equal((await checkCards(['BRO-5646'], { listComments })).dropped.length, 1);
  assert.equal(await main(['BRO-5646', '--strict'], { out() {}, listComments }), 3);
});

test('the Stop hook runs the restate check, advisory unless DECISION_RESTATE_ENFORCE=1', async () => {
  const fs = await import('node:fs');
  const hook = fs.readFileSync(new URL('../../.claude/hooks/verify-edits.sh', import.meta.url), 'utf8');
  assert.match(hook, /scripts\/lib\/decision-restate\.js" --stop-hook/);
  const { stopHook } = require('../../scripts/lib/decision-restate.js');
  const comments = new Map([['BRO-5646', [{ body: 'DECISION NEEDED: pick', createdAt: '2026-10-29T10:00:00Z' }, { body: '**Owner decision** (answered by the owner)\n\nChose: A', createdAt: '2026-10-29T11:00:00Z' }]]]);
  const run = (env, extra = '') => stopHook(JSON.stringify({ last_assistant_message: `DECISION NEEDED: BRO-5646 pick ${extra}` }), { env, listComments: async () => comments, log() {} });
  assert.equal((await run({})).code, 0);
  assert.match((await run({})).message, /ALREADY ANSWERED/);
  assert.equal((await run({ DECISION_RESTATE_ENFORCE: '1' })).code, 2);
  assert.equal((await run({ DECISION_RESTATE_ENFORCE: '1' }, 'NO-VERIFY: x')).code, 0);
  assert.equal((await run({ DECISION_RESTATE_DISABLE: '1', DECISION_RESTATE_ENFORCE: '1' })).code, 0);
  assert.equal((await stopHook('not json', { env: {} })).code, 0);
});

test('review blockers (BRO-6539): voided/needed/undone comments are not answers; new evidence is not settled by an old approval', async () => {
  assert.equal(answerState([ask('2026-10-29T10:00:00Z'), { body: '**Owner decision** (closed without an owner tap through the email link, 2026-10-29 UTC)', createdAt: '2026-10-29T11:00:00Z' }]).answered, false);
  assert.equal(answerState([ask('2026-10-29T10:00:00Z'), { body: 'Owner decision needed: pick a font', createdAt: '2026-10-29T11:00:00Z' }]).answered, false);
  assert.equal(answerState([ask('2026-10-29T10:00:00Z'), { body: 'Visual approval ref VQA-1', createdAt: '2026-10-29T11:00:00Z' }, { body: 'Visual approval void VQV-1', createdAt: '2026-10-29T12:00:00Z' }]).answered, false);
  const { cardAlreadySettled, fingerprintMarker } = require('../../scripts/lib/linear-attach-approval.js');
  const fp1 = 'a'.repeat(12); const fp2 = 'b'.repeat(12);
  const history = [
    { body: `Waiting on your approval: 2 crops.\n\n${fingerprintMarker(fp1)}`, createdAt: '2026-10-02T10:00:00Z' },
    { body: 'Visual approval ref VQA-1', createdAt: '2026-10-02T11:00:00Z' },
  ];
  assert.equal(cardAlreadySettled(history, fp2), null);
  assert.match(cardAlreadySettled(history, fp1), /already on the card/);
  assert.equal(cardAlreadySettled([{ body: '**Owner decision** (answered by the owner)', createdAt: '2026-01-01T00:00:00Z' }], fp1), null);
  const { decisionCardsFromTranscript } = require('../../scripts/lib/decision-restate.js');
  assert.deepEqual(decisionCardsFromTranscript('{"type":"assistant","x":"DECISION NEEDED: BRO-12 pick"}\n{"type":"user","y":"DECISION NEEDED BRO-77 file read"}\n{"y":"BRO-99"}'), ['BRO-12']);
  // legacy card (no fingerprints): an old approval never vouches for new evidence
  assert.equal(cardAlreadySettled([{ body: 'Waiting on your approval: 2 crops', createdAt: '2026-10-01T10:00:00Z' }, { body: 'Owner decision: Approve', createdAt: '2026-10-02T10:00:00Z' }], fp1), null);
  // a rejection written by the real comment builder is not a closing answer
  const link = require('../../src/lib/owner-decision-link.js');
  const rejected = { body: link.buildAnswerComment({ choiceLabel: 'Rejected', text: '', ref: 'r1', now: new Date('2026-10-29T11:00:00Z') }), createdAt: '2026-10-29T11:00:00Z' };
  assert.equal(answerState([ask('2026-10-29T10:00:00Z'), rejected]).answered, false);
  assert.equal(answerState([ask('2026-10-29T10:00:00Z'), { body: 'Visual approval ref VQA-1', createdAt: '2026-10-29T11:00:00Z' }, { body: 'Visual approval stale VQS-1', createdAt: '2026-10-29T12:00:00Z' }]).answered, false);
  assert.ok(link);
});

test('isIssueAnswered reads Linear-shaped comments and fails open', () => {
  const d = require('../../scripts/lib/decision-restate.js');
  assert.equal(d.isIssueAnswered({}), false);
  assert.equal(d.isIssueAnswered({ comments: { nodes: [{ body: 'Asked the owner to look at it', createdAt: '2026-10-29T10:00:00Z' }, { body: 'Owner answered: yes', createdAt: '2026-10-29T11:00:00Z' }] } }), true);
  assert.equal(d.isIssueAnswered({ comments: { nodes: [{ body: 'Owner answered: yes', createdAt: '2026-10-29T09:00:00Z' }, { body: 'Asked the owner to look at it', createdAt: '2026-10-29T10:00:00Z' }] } }), false);
});
