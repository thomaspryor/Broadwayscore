// BRO-6359: a card filed with --child (a create_session child is starting on it now) is In Progress and
// claimed, so no worker picks it. Requires the real functions; nothing is copied here.
import { test, afterEach } from 'node:test';
import { guardProcessExit } from '../../tests/helpers/process-exit-guard.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveDisposition } = require('./card-disposition.js');
const { takeableParkAdvisory, commentClearsOwnerGate } = require('./headless-dispatchability.js');
const { pickCloudCard } = require('./cloud-worker-pick.js');
const { freshClaimGuard } = require('./fresh-claim-guard.js');
const { buildClaimComment } = require('./linear-session-reporting.js');
const { pickStateForMode } = require('./linear-issue-create.js');

guardProcessExit();
afterEach(() => { process.exitCode = 0; });

const NOW = Date.parse('2026-10-26T14:00:00Z');
const states = [
  { id: 's1', name: 'Backlog', type: 'backlog' },
  { id: 's2', name: 'Todo', type: 'unstarted' },
  { id: 's3', name: 'In Progress', type: 'started' },
];
const notes = 'Fix it.\n\n## Acceptance criteria\n\n* works\n  VERIFY: node --test scripts/lib/some.test.mjs\n';

test('--child resolves to the self disposition; empty child does not', () => {
  assert.equal(resolveDisposition({ child: 'BRO-1: do the thing' }).mode, 'self');
  assert.equal(resolveDisposition({ child: '  ' }).reason, 'NO_DISPOSITION');
  assert.equal(resolveDisposition({ child: 'BRO-1: do it', dispatch: true }).reason, 'BOTH_FLAGS');
});

test('self mode files In Progress, not Todo', () => {
  assert.equal(pickStateForMode(states, 'self').name, 'In Progress');
});

test('a child-claimed (In Progress) card is skipped by the cloud picker; the same card in Todo is picked', () => {
  const base = {
    title: 'child card', description: notes, priority: 2,
    createdAt: '2026-10-26T06:00:00Z', updatedAt: '2026-10-26T06:00:00Z',
  };
  const claimed = { ...base, identifier: 'BRO-9001', state: { name: 'In Progress', type: 'started' } };
  const todo = { ...base, identifier: 'BRO-9002', state: { name: 'Todo', type: 'unstarted' } };
  const r = pickCloudCard([claimed], { nowMs: NOW });
  assert.equal(r.pick, null);
  assert.equal(r.skipped['state-started'], 1);
  // control: the identical card in Todo is takeable, so the skip above is the state, not the fixture
  assert.equal(pickCloudCard([todo], { nowMs: NOW }).pick.identifier, 'BRO-9002');
});

test('linear-next fresh-claim guard refuses a card carrying the child claim comment', () => {
  const comments = [{ body: buildClaimComment({ sessionRef: 'cloud:parent', ts: '2026-10-26T13:55:00Z' }), createdAt: '2026-10-26T13:55:00Z' }];
  const msg = freshClaimGuard('BRO-9001', comments, NOW, {});
  assert.match(msg, /REFUSING to dispatch BRO-9001/);
});

test('the PARK-ADVISORY names --child as the way out', () => {
  assert.match(takeableParkAdvisory('technical cleanup needs doing sometime'), /--child/);
});

test('linear-brain create --child files In Progress with a child claim comment; short/conflicting values exit', async () => {
  const { main } = require('../linear-brain.js');
  const filed = []; const comments = [];
  const deps = {
    createLinearIssue: async (o) => { filed.push(o); return { issue: { id: 'u1', identifier: 'BRO-9100', title: o.title }, mode: 'self', stateName: 'In Progress' }; },
    createComment: async (id, body) => { comments.push(body); },
    fetchAnsweredCards: async () => [],
    coordinatorReminder: async () => {},
  };
  await main(['create', 'child card', '--child', 'BRO-9100: do the thing', '--notes', notes], deps);
  assert.equal(filed[0].child, 'BRO-9100: do the thing');
  assert.equal(filed[0].dispatch, undefined);
  assert.match(comments[0], /^Claimed by /);
  assert.match(comments[0], /Child session starting on this card now: BRO-9100: do the thing/);
  const realExit = process.exit; const codes = [];
  process.exit = (c) => { codes.push(c); throw new Error('exit'); };
  try {
    for (const argv of [['--child', 'short'], ['--child', 'BRO-9100: do the thing', '--mac-only', 'needs the Mac for a thing']]) {
      await assert.rejects(main(['create', 'x', ...argv, '--notes', notes], deps), /exit/);
    }
  } finally { process.exit = realExit; }
  assert.deepEqual(codes, [1, 1]);
});

// BRO-6443: the board's own tooling writes these two lines; they must clear the gate.
test('commentClearsOwnerGate: triage "Owner gate removed" and the answer path "Owner decision" comments clear it', () => {
  assert.equal(commentClearsOwnerGate(['Owner gate removed by BRO-6235 (checked 2026-10-25): this is not a question for the owner.']), true);
  assert.equal(commentClearsOwnerGate(['**Owner decision** (answered by the owner through the email link, 2026-10-25 UTC)\n\nChose: Option A', 'Listed in the owner\'s decisions email.'], ''), true);
  assert.equal(commentClearsOwnerGate(['OWNER-CLEARED: technical call']), true);
});

test('commentClearsOwnerGate: an answered-decision comment does not clear a card that still has an open question', () => {
  const answered = ['**Owner decision** (answered by the owner through the email link)\n\nChose: Option A'];
  assert.equal(commentClearsOwnerGate(answered, 'ANSWERED by the owner: first? -> A\nDECISION NEEDED: second question?'), false);
  assert.equal(commentClearsOwnerGate(answered, 'ANSWERED by the owner: first? -> A'), true);
});

test('commentClearsOwnerGate: ordinary comments, a mid-line mention and a re-ask do not clear it', () => {
  assert.equal(commentClearsOwnerGate(['Claimed by a worker']), false);
  assert.equal(commentClearsOwnerGate(['The owner gate removed earlier was wrong']), false);
  assert.equal(commentClearsOwnerGate(['Owner gate removed by triage.', 'DECISION NEEDED: keep or drop this?']), false);
});

test('commentClearsOwnerGate: other owner wording, a DECISION NEEDED title and a vague "removed" note keep the gate shut', () => {
  const answered = ['**Owner decision** (answered by the owner through the email link)\n\nChose: Option A'];
  assert.equal(commentClearsOwnerGate(answered, 'ANSWERED by the owner: Q1? -> A\n\nOwner must approve the new vendor.'), false);
  assert.equal(commentClearsOwnerGate(answered, 'DECISION NEEDED: keep?\nANSWERED by the owner: Q1? -> A'), false);
  assert.equal(commentClearsOwnerGate(['Owner gate removed by mistake; still needs you.']), false);
});
