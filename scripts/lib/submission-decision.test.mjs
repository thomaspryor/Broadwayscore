import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { alreadyListedResult, finalizeLlmRecommendation, ALREADY_LISTED } = require('./submission-decision.js');

test('a review we already list is never a reject (issue #1180, NYSR Rope)', () => {
  const r = alreadyListedResult(
    { isDuplicate: true, location: 'reviews.json', showId: 'rope-off-broadway-2026' },
    { id: 'rope-off-broadway-2026', title: 'Rope', category: 'off-broadway' },
  );
  assert.equal(r.recommendation, ALREADY_LISTED);
  assert.notEqual(r.recommendation, 'reject');
  assert.equal(r.extractedData.showId, 'rope-off-broadway-2026');
  assert.equal(r.showUrl, 'https://broadwayscorecard.com/show/rope-off-broadway-2026');
});

test('a West End duplicate links to the West End site', () => {
  const r = alreadyListedResult(
    { isDuplicate: true, location: 'reviews.json', showId: 'x-west-end-2026' },
    { id: 'x-west-end-2026', title: 'X', category: 'west-end' },
  );
  assert.equal(r.showUrl, 'https://westendscorecard.com/show/x-west-end-2026');
});

test('duplicate with no show record still resolves the show id, no link', () => {
  const r = alreadyListedResult({ isDuplicate: true, location: 'reviews.json', showId: 'gone-2020' }, null);
  assert.equal(r.extractedData.showId, 'gone-2020');
  assert.equal(r.showUrl, null);
});

test('LLM reject of a registered outlet goes to manual review (#1074, #1114)', () => {
  const out = finalizeLlmRecommendation(
    { recommendation: 'reject', reasoning: 'Off-West-End is NOT in our covered markets' },
    { id: 'view-from-row-jay', displayName: 'A View from Row J(ay)' },
  );
  assert.equal(out.recommendation, 'needs-manual-review');
  assert.match(out.reasoning, /A View from Row J\(ay\)/);
  assert.match(out.reasoning, /Off-West-End/);
});

test('LLM reject of an unknown outlet stays a reject', () => {
  const llm = { recommendation: 'reject', reasoning: 'not a review' };
  assert.equal(finalizeLlmRecommendation(llm, null).recommendation, 'reject');
});

test('approve and manual review pass through untouched', () => {
  const outlet = { id: 'nysr', displayName: 'New York Stage Review' };
  assert.equal(finalizeLlmRecommendation({ recommendation: 'approve' }, outlet).recommendation, 'approve');
  assert.equal(finalizeLlmRecommendation({ recommendation: 'needs-manual-review' }, outlet).recommendation, 'needs-manual-review');
});

const { rejectKind, rejectEmailText, alreadyListedEmailText } = require('./submission-decision.js');

test('reject emails never claim an untracked outlet for a page-type reject', () => {
  const t = rejectEmailText('not-a-review-page', 'https://x.com/a');
  assert.match(t, /listing, ticketing/);
  assert.doesNotMatch(t, /publication/);
});

test('rejectKind: deterministic kinds pass through, LLM reject is untracked-outlet, others empty', () => {
  assert.equal(rejectKind({ recommendation: 'reject', rejectKind: 'no-url' }), 'no-url');
  assert.equal(rejectKind({ recommendation: 'reject' }), 'other');
  assert.equal(rejectKind({ recommendation: 'reject', validationDetails: { isReview: true, isCoveredMarket: false, isLegitimateOutlet: true } }), 'outside-market');
  assert.equal(rejectKind({ recommendation: 'reject', validationDetails: { isReview: true, isCoveredMarket: true, isLegitimateOutlet: false } }), 'untracked-outlet');
  assert.equal(rejectKind({ recommendation: 'reject', validationDetails: { isReview: false } }), 'not-a-review-page');
  assert.equal(rejectKind({ recommendation: ALREADY_LISTED }), '');
});

test('already-listed email links the show, or reads cleanly without a link', () => {
  assert.match(alreadyListedEmailText('u', 'https://broadwayscorecard.com/show/rope-off-broadway'), /already on Broadway Scorecard, here:\n\nhttps:/);
  assert.match(alreadyListedEmailText('u', ''), /already on Broadway Scorecard\.\n/);
});

test('no submitter email uses the old generic "unable to add" wording', () => {
  for (const k of ['no-url', 'not-a-review-page', 'outside-market', 'untracked-outlet', 'other']) {
    assert.doesNotMatch(rejectEmailText(k, 'u'), /unable to add|Common reasons/);
  }
});

test('no-url email has no blank link line', () => {
  assert.doesNotMatch(rejectEmailText('no-url', ''), /:\n\n\n/);
});

test('a local-only show gets no link (its page is withheld)', () => {
  const r = alreadyListedResult(
    { isDuplicate: true, location: 'reviews.json', showId: 'x-regional-2026' },
    { id: 'x-regional-2026', title: 'X', category: 'regional', localOnly: true },
  );
  assert.equal(r.showUrl, null);
});
