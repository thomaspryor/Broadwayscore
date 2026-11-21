import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildEscalationCard, fileFeedbackCard, isOpenTwin } = require('./plan-refusal-escalation.js');
const { evaluateVerifiability } = require('./verify-gate.js');

test('buildEscalationCard requires an issue number', () => {
  assert.throws(() => buildEscalationCard({}), /issueNumber/);
});

test('buildEscalationCard files a self-contained backlog card (Problem/Suggested approach/Acceptance criteria)', () => {
  const card = buildEscalationCard({
    diagnosis: { submitterName: 'Jane Doe', submitterShow: 'Wonder (Regional)', summary: 'Missing WSJ review' },
    planReason: 'Cannot verify paywalled outlet text without owner cookies',
    issueNumber: 516,
    issueUrl: 'https://github.com/thomaspryor/Broadwayscore/issues/516',
  });

  assert.equal(card.priority, 'P1');
  assert.equal(card.status, 'Not started');
  assert.equal(card.action, 'Investigate');
  assert.match(card.title, /#516/);
  assert.match(card.title, /Wonder \(Regional\)/);
  assert.match(card.notes, /## Problem/);
  assert.match(card.notes, /## Suggested approach/);
  assert.match(card.notes, /## Acceptance criteria/);
  assert.doesNotMatch(card.notes, /Jane Doe/); // public repo: no reader name (BRO-7600)
  assert.match(card.notes, /Cannot verify paywalled outlet text/);
  assert.match(card.notes, /issue-closed=516/);
});

test('buildEscalationCard falls back to generic wording when diagnosis fields are missing', () => {
  const card = buildEscalationCard({ diagnosis: {}, planReason: '', issueNumber: 42 });
  assert.match(card.title, /#42/);
  assert.match(card.title, /unscoped feedback/);
  assert.match(card.notes, /A reader reported a bug/);
  assert.match(card.notes, /no reason given/);
});

test('buildEscalationCard truncates very long fields instead of blowing up the card', () => {
  const longReason = 'x'.repeat(1000);
  const card = buildEscalationCard({ diagnosis: {}, planReason: longReason, issueNumber: 7 });
  assert.ok(card.notes.length < longReason.length + 500);
  assert.match(card.notes, /…/);
});

// Regression: bsc-next.js refuses to dispatch a 'Not started' backlog card
// unless evaluateVerifiability() reports armed:true (real command OR
// VERIFY: owner-judgment). An unarmed card silently reproduces the exact
// "files something, nothing ever picks it up" dead end this feature exists
// to close — ship-check finding (2026-08-02): the original notes cited
// `gh issue view N` as the acceptance criteria, which isn't a SAFE_CHECK_FORMS
// command, so the card would have been filed but never auto-dispatched.
test('buildEscalationCard notes are armed for bsc-next dispatch', () => {
  const card = buildEscalationCard({ diagnosis: {}, planReason: 'x', issueNumber: 1 });
  const verdict = evaluateVerifiability(card.notes);
  assert.equal(verdict.armed, true);
  assert.equal(verdict.cmd, 'node scripts/check-review-item-resolved.js --issue-closed=1');
  assert.equal(verdict.ownerJudgment, false);
});

test('fileFeedbackCard files with --dispatch, never --park, and names no reader', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return args[0] === 'find' ? 'null\n' : ''; };
  const res = fileFeedbackCard({
    diagnosis: { submitterName: 'Jane Doe', submitterEmail: 'jane@example.com', submitterShow: 'Wonder' },
    planState: 'created', issueNumber: 900,
  }, { run });
  assert.equal(res.filed, true);
  const create = calls.find((c) => c[0] === 'create');
  assert.ok(create.includes('--dispatch'));
  assert.ok(!create.includes('--park'));
  assert.match(create[1], /^Feedback #900: Wonder$/);
  assert.doesNotMatch(create.join(' '), /Jane Doe|jane@example/);
  assert.match(create.join(' '), /data\/pending-fixes/);
});

test('fileFeedbackCard dedupes by GitHub issue number (open card whose title starts Feedback #N:)', () => {
  const calls = [];
  const run = (args) => { calls.push(args[0]); return JSON.stringify({ identifier: 'BRO-1', title: 'Feedback #901: Wonder' }); };
  const res = fileFeedbackCard({ diagnosis: {}, issueNumber: 901 }, { run });
  assert.deepEqual(calls, ['find']);
  assert.equal(res.reused, true);
  // #90 must not be treated as a twin of #901's card
  assert.equal(isOpenTwin(JSON.stringify({ title: 'Feedback #901: x' }), 90), false);
  // find matches descriptions too: a card merely mentioning the issue is not a twin
  assert.equal(isOpenTwin(JSON.stringify({ title: 'Cron failed: Feedback #901: mention' }), 901), false);
  assert.equal(isOpenTwin('null', 901), false);
});

test('fileFeedbackCard fails open on find error and soft on create error, without echoing argv', () => {
  const run = (args) => {
    if (args[0] === 'find') throw new Error('find boom');
    const e = new Error(`Command failed: node linear-brain.js ${args.join(' ')}`); e.status = 2; throw e;
  };
  const res = fileFeedbackCard({ diagnosis: { summary: 'secret reader text' }, issueNumber: 5 }, { run });
  assert.equal(res.filed, false);
  assert.equal(res.error, 'linear-brain create exited 2');
  assert.doesNotMatch(JSON.stringify(res), /secret reader text/);
});

test('isOpenTwin parses the indented multi-line JSON linear-brain find really prints', () => {
  const real = JSON.stringify({ identifier: 'BRO-9', title: 'Feedback #901: Wonder', stateName: 'Todo' }, null, 2) + '\n';
  assert.equal(isOpenTwin(real, 901), true);
  assert.equal(isOpenTwin(`[linear] note\n${real}`, 901), true);
});

// ---------------------------------------------------------------------------
// BRO-7606: review submissions labelled needs-manual-review get one card too.
const {
  buildReviewSubmissionCard, fileReviewSubmissionCard, reviewSubmissionsNeedingCard, CARD_FILED_LABEL,
} = require('./plan-refusal-escalation.js');
const { main: fileReviewSubmissionCardCli } = require('../file-review-submission-card.js');

test('buildReviewSubmissionCard: fixed title per issue, armed VERIFY, no submitter PII', () => {
  const card = buildReviewSubmissionCard({
    issueNumber: 1159, reviewUrl: 'https://thecritic.co.uk/x-review/', showId: 'x-2026',
    reason: 'outlet not registered; contact jane@example.com',
  });
  assert.equal(card.title, 'Review submission #1159: needs a manual check');
  // the sweep knows no show or reason, and must compute the same title
  assert.equal(buildReviewSubmissionCard({ issueNumber: 1159 }).title, card.title);
  assert.match(card.notes, /## Problem[\s\S]*## Suggested approach[\s\S]*## Acceptance criteria/);
  assert.match(card.notes, /thecritic\.co\.uk\/x-review/);
  assert.match(card.notes, /x-2026/);
  assert.doesNotMatch(card.notes, /jane@example\.com/);
  const verdict = evaluateVerifiability(card.notes);
  assert.equal(verdict.armed, true);
  assert.equal(verdict.cmd, 'node scripts/check-review-item-resolved.js --issue-closed=1159');
  assert.throws(() => buildReviewSubmissionCard({}), /issueNumber/);
});

test('fileReviewSubmissionCard files --dispatch once, then reuses the open card for the same issue', () => {
  const board = [];
  const run = (args) => {
    if (args[0] === 'find') {
      // the fixed title is looked up exactly, so a card that merely quotes it can't hide the twin
      assert.ok(args.includes('--exact-title'));
      const hit = board.find((t) => t === args[1]);
      return hit ? JSON.stringify({ identifier: 'BRO-1', title: hit }, null, 2) : 'null\n';
    }
    assert.ok(args.includes('--dispatch'));
    assert.ok(!args.includes('--park'));
    assert.ok(args.includes('workflow:process-review-submission'));
    board.push(args[1]);
    return '';
  };
  const first = fileReviewSubmissionCard({ issueNumber: 1200, reason: 'validation could not decide' }, { run });
  const second = fileReviewSubmissionCard({ issueNumber: 1200, showId: 'other' }, { run });
  assert.equal(first.filed, true);
  assert.equal(second.reused, true);
  assert.equal(board.length, 1);
  // a feedback card for the same GitHub number is not a twin, nor is #120
  board.length = 0; board.push('Feedback #1200: Wonder');
  assert.equal(fileReviewSubmissionCard({ issueNumber: 1200 }, { run }).filed, true);
  board.length = 0; board.push('Review submission #1200: needs a manual check');
  assert.equal(fileReviewSubmissionCard({ issueNumber: 120 }, { run }).filed, true);
});

test('reviewSubmissionsNeedingCard: parked review submissions without the linear-card label', () => {
  const issue = (number, title, labels) => ({ number, title, labels: labels.map((name) => ({ name })) });
  const picked = reviewSubmissionsNeedingCard([
    issue(1, '[Review Submission] A', ['needs-manual-review']),
    issue(2, '[Review Submission] B', ['scraping-failed']),
    issue(3, '[Review Submission] C', ['needs-manual-review', CARD_FILED_LABEL]),
    issue(4, '[Bug] D', ['needs-manual-review']),
    issue(5, '[Review Submission] E', ['awaiting-score']),
  ]).map((i) => i.number);
  assert.deepEqual(picked, [1, 2]);
  // settle window: an issue the per-issue step touched 2 min ago is left alone
  const now = Date.parse('2026-11-16T12:00:00Z');
  const fresh = { ...issue(6, '[Review Submission] F', ['needs-manual-review']), updatedAt: '2026-11-16T11:58:00Z' };
  const old = { ...issue(7, '[Review Submission] G', ['needs-manual-review']), updatedAt: '2026-11-16T11:00:00Z' };
  assert.deepEqual(reviewSubmissionsNeedingCard([fresh, old], { now, settleMs: 15 * 60 * 1000 }).map((i) => i.number), [7]);
});

test('file-review-submission-card CLI: env mode files and labels; sweep caps and skips labelled issues', () => {
  const calls = [];
  const deps = {
    run: (args) => { calls.push(['linear', args[0]]); return args[0] === 'find' ? 'null' : ''; },
    runGh: (args) => {
      calls.push(['gh', args.slice(0, 2).join(' ')]);
      if (args[0] === 'issue') {
        return args[args.indexOf('--label') + 1] === 'needs-manual-review' ? JSON.stringify([
          { number: 11, title: '[Review Submission] a', body: '### Review URL\n\nhttps://ex.com/r\n', labels: [{ name: 'needs-manual-review' }] },
          { number: 12, title: '[Review Submission] b', body: '', labels: [{ name: 'needs-manual-review' }, { name: CARD_FILED_LABEL }] },
          { number: 13, title: '[Review Submission] c', body: '', labels: [{ name: 'needs-manual-review' }] },
        ]) : '[]';
      }
      return '';
    },
  };
  assert.equal(fileReviewSubmissionCardCli([], { ISSUE_NUMBER: '77', REASON: 'r' }, deps), 0);
  assert.deepEqual(calls, [['linear', 'find'], ['linear', 'create'], ['gh', 'api -X']]);
  calls.length = 0;
  fileReviewSubmissionCardCli(['--sweep', '--max=1'], {}, deps);
  assert.equal(calls.filter((c) => c[1] === 'create').length, 1); // capped at 1, #12 skipped
  calls.length = 0;
  assert.equal(fileReviewSubmissionCardCli([], { ISSUE_NUMBER: '' }, deps), 0);
  assert.equal(calls.length, 0);
});

test('closeReviewSubmissionCard: finds the open card by exact title and moves it to Done', () => {
  const { closeReviewSubmissionCard } = require('./plan-refusal-escalation.js');
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args[0] === 'find' ? JSON.stringify({ identifier: 'BRO-9001', title: 'Review submission #1178: needs a manual check' }) : '';
  };
  const r = closeReviewSubmissionCard({ issueNumber: '1178' }, { run });
  assert.deepEqual(r, { closed: true, identifier: 'BRO-9001' });
  assert.deepEqual(calls[1].slice(0, 4), ['update', 'BRO-9001', '--state', 'Done']);
});

test('closeReviewSubmissionCard: no open card, or a find/update failure, never throws', () => {
  const { closeReviewSubmissionCard } = require('./plan-refusal-escalation.js');
  assert.equal(closeReviewSubmissionCard({ issueNumber: '1' }, { run: () => 'null' }).closed, false);
  assert.equal(closeReviewSubmissionCard({ issueNumber: '1' }, { run: () => { throw new Error('boom'); } }).closed, false);
  const run = (a) => { if (a[0] === 'update') { const e = new Error('x'); e.status = 5; throw e; } return JSON.stringify({ identifier: 'BRO-2', title: 'Review submission #1: needs a manual check' }); };
  assert.match(closeReviewSubmissionCard({ issueNumber: '1' }, { run }).reason, /update exited 5/);
});
