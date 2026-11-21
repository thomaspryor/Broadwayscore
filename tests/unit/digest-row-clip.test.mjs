// Card #1078: renderHealthDigestBlock (scripts/lib/autonomous-email-render.js)
// clips every queued row's description to 200 chars — nothing checked that
// the surviving head still reads as a complete thought. headStandsAlone()
// is the generalized guard queueDigestLine() now runs on every row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { headStandsAlone } = require('../../scripts/lib/owner-alert-router.js');

test('a well-formed front-loaded description passes', () => {
  const description = 'The Outsiders review gap: WSJ published 3 days ago but the '
    + 'text never landed in review-texts/ — check the discovery log for a silent SERP miss.';
  const result = headStandsAlone(description, 'The Outsiders');
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('a bracket-tag-led description fails', () => {
  const description = '[STUCK] Lincoln Center gala benefit — this run has been waiting '
    + 'for a dispatcher pickup for over 24 hours with no auto-attempt on record.';
  const result = headStandsAlone(description, 'Lincoln Center gala benefit');
  assert.equal(result.ok, false);
  assert.match(result.reason, /bracket tag/);
});

test('an indented-second-line-only description fails', () => {
  const description = '\n  Lincoln Center gala benefit needs a decision on refund policy '
    + 'before the box office can process the 40 pending requests from last week.';
  const result = headStandsAlone(description, 'Lincoln Center gala benefit');
  assert.equal(result.ok, false);
  assert.match(result.reason, /indented detail line/);
});

test('a short description is always fine', () => {
  // No subject passed — isolates this from the subject rule so it only
  // exercises the length/structural path (mirrors queueDigestLine's own
  // description check, which never passes a subject either).
  const result = headStandsAlone('All clear, nothing to report.');
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('a missing/empty description is always fine', () => {
  assert.equal(headStandsAlone(undefined, 'Some Show').ok, true);
  assert.equal(headStandsAlone('', 'Some Show').ok, true);
});

test('a well-formed head that never names the subject fails', () => {
  const description = 'Something odd happened overnight and the numbers look off compared '
    + 'to yesterday, worth a look when you get a chance sometime this week.';
  const result = headStandsAlone(description, 'The Outsiders');
  assert.equal(result.ok, false);
  assert.match(result.reason, /subject/);
});

// This is the assertion the bracket-tag case must trip, per the card's
// acceptance criteria — removing the check must break this test.
test('the guard actually catches the bracket-tag regression class', () => {
  const regressed = '[LIVE] 4 user requests now live on the site — see the digest for details.';
  assert.equal(headStandsAlone(regressed, 'user requests').ok, false);
});
