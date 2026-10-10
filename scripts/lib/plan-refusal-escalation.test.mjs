import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildEscalationCard } = require('./plan-refusal-escalation.js');
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
  assert.match(card.notes, /Jane Doe/);
  assert.match(card.notes, /Cannot verify paywalled outlet text/);
  assert.match(card.notes, /gh issue view 516/);
});

test('buildEscalationCard falls back to generic wording when diagnosis fields are missing', () => {
  const card = buildEscalationCard({ diagnosis: {}, planReason: '', issueNumber: 42 });
  assert.match(card.title, /#42/);
  assert.match(card.title, /unscoped feedback/);
  assert.match(card.notes, /A reporter reported a bug/);
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
  assert.equal(verdict.ownerJudgment, true);
});
