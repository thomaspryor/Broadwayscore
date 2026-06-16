// Repeat workflow failures must be promoted from a passive digest body section
// into first-class check results so they drive the digest subject line and the
// escalation machinery — the gap that let main test.yml fail 11/19 push runs
// over 2026-06-13→15 without ever bumping the digest off "All clear".
// Notion 381637c5-416f-815b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { repeatFailureResults, getDigestSubject, getPlaybookEntry } = require('../../scripts/health-check.js');

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
