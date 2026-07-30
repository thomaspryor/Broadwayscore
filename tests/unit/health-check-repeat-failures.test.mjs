// Repeat workflow failures must be promoted from a passive digest body section
// into first-class check results so they drive the digest subject line and the
// escalation machinery — the gap that let main test.yml fail 11/19 push runs
// over 2026-06-13→15 without ever bumping the digest off "All clear".
// Notion 381637c5-416f-815b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { repeatFailureResults, feedbackBacklogResults, obClosingBacklogResults, cardVerifiabilityBacklogResults, getDigestSubject, getPlaybookEntry } = require('../../scripts/health-check.js');

test('repeatFailureResults: skipped summary yields no synthetic checks', () => {
  assert.deepEqual(repeatFailureResults({ skipped: true, repeatFailures: [{ name: 'x.yml', count: 9 }] }), []);
  assert.deepEqual(repeatFailureResults(null), []);
  assert.deepEqual(repeatFailureResults(undefined), []);
});

test('repeatFailureResults: clean window yields no synthetic checks', () => {
  assert.deepEqual(repeatFailureResults({ skipped: false, repeatFailures: [] }), []);
});

test('repeatFailureResults: count>=3 is error, exactly 2 is warn', () => {
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [
      { name: 'update-lottery-rush.yml', count: 4, latestUrl: 'https://x/4' },
      { name: 'weekly-grosses.yml', count: 2, latestUrl: 'https://x/2' },
    ],
  });
  assert.equal(results.length, 2);
  const lottery = results.find(r => r.name === 'Workflow repeat-failure: update-lottery-rush.yml');
  const grosses = results.find(r => r.name === 'Workflow repeat-failure: weekly-grosses.yml');
  assert.equal(lottery.status, 'error');
  assert.equal(grosses.status, 'warn');
  assert.match(lottery.message, /failed 4 times/);
});

test('playbook routes repeat-failure checks to fix-now (actionable, not low)', () => {
  const entry = getPlaybookEntry('Workflow repeat-failure: update-lottery-rush.yml');
  assert.ok(entry, 'expected a playbook entry to match');
  assert.equal(entry.urgency, 'fix-now');
});

test('getDigestSubject: a promoted repeat-failure error names the workflow (not "All clear")', () => {
  const results = [
    { name: 'Freshness: reviews.json', status: 'pass', message: 'ok' },
    ...repeatFailureResults({
      skipped: false,
      repeatFailures: [{ name: 'update-lottery-rush.yml', count: 5, latestUrl: 'https://x/5' }],
    }),
  ];
  // consecutiveErrorDays >= 2 → ACTION NEEDED branch, which names the first error.
  const subject = getDigestSubject(results, { consecutiveErrorDays: 2 }, {});
  assert.match(subject, /ACTION NEEDED/);
  assert.match(subject, /Workflow repeat-failure: update-lottery-rush\.yml/);
  assert.doesNotMatch(subject, /All clear/);
});

test('getDigestSubject: first-day single repeat-failure error still flags attention', () => {
  const results = repeatFailureResults({
    skipped: false,
    repeatFailures: [{ name: 'weekly-grosses.yml', count: 3, latestUrl: 'https://x/3' }],
  });
  const subject = getDigestSubject(results, { consecutiveErrorDays: 1 }, {});
  assert.match(subject, /1 error need attention/);
  assert.doesNotMatch(subject, /All clear/);
});

test('getDigestSubject: clean window stays green', () => {
  const results = [
    { name: 'Freshness: reviews.json', status: 'pass', message: 'ok' },
    ...repeatFailureResults({ skipped: false, repeatFailures: [] }),
  ];
  const subject = getDigestSubject(results, { consecutiveErrorDays: 0 }, {});
  assert.match(subject, /All clear/);
});

// --- feedbackBacklogResults (needs-manual-review backlog digest check) ---

test('feedbackBacklogResults: empty backlog and skipped summary yield no results', () => {
  assert.deepEqual(feedbackBacklogResults({ skipped: false, issues: [] }), []);
  assert.deepEqual(feedbackBacklogResults({ skipped: true, issues: [] }), []);
  assert.deepEqual(feedbackBacklogResults(null), []);
});

test('feedbackBacklogResults: open backlog warns with count, oldest age, newest title', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const results = feedbackBacklogResults({
    skipped: false,
    issues: [
      { number: 393, title: 'Bug Diagnosis: MISTERMAN FRC score', createdAt: '2026-07-03T17:00:41Z' },
      { number: 279, title: 'Bug Diagnosis: fluctuating scores', createdAt: '2026-04-24T09:34:49Z' },
    ],
  }, now);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /2 open user-feedback issue\(s\)/);
  assert.match(results[0].message, /oldest 78d/);
  assert.match(results[0].message, /#393/);
});

// --- obClosingBacklogResults (weekly OB closing-detector digest check) ---

test('obClosingBacklogResults: empty or absent report yields nothing', () => {
  assert.deepEqual(obClosingBacklogResults(null), []);
  assert.deepEqual(obClosingBacklogResults({ reviewTextSweep: { candidates: [] }, todaytixStaleness: { candidates: [] } }), []);
});

test('obClosingBacklogResults: candidates warn with count and first show', () => {
  const results = obClosingBacklogResults({
    reviewTextSweep: { candidates: [{ showId: 'clara-2026', proposedClosingDate: '2026-05-10', confidence: 'medium' }] },
    todaytixStaleness: { candidates: [] },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /1 open Off-Broadway show/);
  assert.match(results[0].message, /clara-2026 → 2026-05-10 \[medium\]/);
});

// --- cardVerifiabilityBacklogResults (task #646: undispatchable backlog cards) ---

test('cardVerifiabilityBacklogResults: empty or absent report yields nothing', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults(null), []);
  assert.deepEqual(cardVerifiabilityBacklogResults({ total: 40, refused: [] }), []);
});

test('cardVerifiabilityBacklogResults: refused cards warn with count and first card', () => {
  const results = cardVerifiabilityBacklogResults({
    total: 42,
    refusedCount: 2,
    refused: [
      { id: 'abc', name: 'Fix the widget', priority: 'P1 Next', reason: 'names no runnable command (prose only)' },
      { id: 'def', name: 'Another card', priority: 'P2 Later', reason: 'no acceptance-criteria section or VERIFY line' },
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /2 of 42 pending\/in-progress card/);
  assert.match(results[0].message, /\[P1 Next\] Fix the widget/);
  assert.match(results[0].hint, /enrich-card-acceptance\.js/);
});
