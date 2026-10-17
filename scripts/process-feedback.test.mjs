import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldSendThankYouNow } = require('./lib/feedback-thank-you-gate.js');
const { planContentRequestActions } = require('./lib/content-request-routing.js');

// BRO-129: process-feedback.js sends the thank-you email from classification
// output alone, before add-requested-show.yml (dispatched separately, later,
// asynchronously) has any outcome to report. These tests exercise the real
// gate (shouldSendThankYouNow) the script calls, and the real routing
// function (planContentRequestActions) that produces the downstream action —
// proving the email decision is unaffected by whatever that downstream step
// goes on to do.

test('a content-addition request ("add my show") gets a thank-you now', () => {
  const categorized = { category: 'Content Error', contentRequest: true, submissionNumber: 1 };
  assert.equal(shouldSendThankYouNow(categorized), true);
});

test('thank-you decision is identical whether the downstream add-show action would later be accepted or rejected', () => {
  const categorized = { category: 'Content Error', contentRequest: true, submissionNumber: 1 };

  // What process-feedback.js actually computes for this submission before
  // dispatch — a 'missing-show' action targeting add-requested-show.yml.
  const actions = planContentRequestActions({
    message: 'Please add "Some New Play" — it just opened at a small venue.',
    show: 'Some New Play',
    shows: [],
  });
  const dispatched = actions.find((a) => a.kind === 'missing-show');
  assert.ok(dispatched, 'sanity check: this message routes to a missing-show dispatch');

  // Three outcomes add-requested-show.js can reach in that LATER, SEPARATE
  // workflow run (scripts/add-requested-show.js): accepted, rejected as a
  // title mismatch, or left stillStaged pending a human decision. Passed
  // as an extra argument here to prove shouldSendThankYouNow ignores it —
  // its signature only reads the categorizer's output.
  const acceptedOutcome = { status: 'accepted' };
  const rejectedOutcome = { status: 'reject', reason: 'title-mismatch' };
  const stagedOutcome = { stillStaged: true };

  const withAccepted = shouldSendThankYouNow(categorized, acceptedOutcome);
  const withRejected = shouldSendThankYouNow(categorized, rejectedOutcome);
  const withStaged = shouldSendThankYouNow(categorized, stagedOutcome);

  assert.equal(withAccepted, true);
  assert.equal(withRejected, true);
  assert.equal(withStaged, true);
  assert.equal(shouldSendThankYouNow.length, 1, 'shouldSendThankYouNow accepts no dispatch-outcome parameter');
});

test('a plain bug report (not a content request) is NOT thanked now — acknowledged after resolution instead', () => {
  const categorized = { category: 'Bug', contentRequest: false, submissionNumber: 1 };
  assert.equal(shouldSendThankYouNow(categorized), false);
});

test('a Content Error that is not a content-addition request is NOT thanked now', () => {
  const categorized = { category: 'Content Error', contentRequest: false, submissionNumber: 1 };
  assert.equal(shouldSendThankYouNow(categorized), false);
});

test('Praise, Feature Request, and Other are always thanked now', () => {
  for (const category of ['Praise', 'Feature Request', 'Other']) {
    assert.equal(shouldSendThankYouNow({ category, contentRequest: false }), true, category);
  }
});
