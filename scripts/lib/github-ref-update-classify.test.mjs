// Unit tests for github-ref-update-classify.js (BRO-2951).
//
// Per CLAUDE.md §15 these require() the REAL function — no logic is copied
// into this file, so a production change that breaks the mapping fails here.
//
// The cases are not hypothetical. The 422 pair and the 403 pair are the two
// forks plan-review flagged as the ones that turn a transient condition into
// an abandoned push (or an unfixable rejection into a hot retry loop), and
// the "not a fast forward" body string is the VERBATIM response GitHub
// returned for this repo when a non-fast-forward PATCH was attempted against
// refs/heads/main on 2026-09-08.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyRefUpdate, isRetryable } = require('./github-ref-update-classify.js');

const LIVE_422_BODY = JSON.stringify({
  message: 'Update is not a fast forward',
  documentation_url: 'https://docs.github.com/rest/git/refs#update-a-reference',
  status: '422',
});

test('2xx is success', () => {
  assert.equal(classifyRefUpdate({ status: 200 }).outcome, 'success');
  assert.equal(classifyRefUpdate({ status: 201 }).outcome, 'success');
});

test('the live 422 non-fast-forward body is a lost race, not a fatal', () => {
  const r = classifyRefUpdate({ status: 422, body: LIVE_422_BODY });
  assert.equal(r.outcome, 'race');
  assert.match(r.reason, /not a fast forward/i);
  assert.equal(isRetryable(r.outcome), true);
});

test('a 422 that is NOT a non-fast-forward is fatal, never a race', () => {
  // Classifying this as a race is the hot-retry-loop bug: retrying a
  // protection rejection can never succeed, and it would report the run as
  // "lost the ref race" — the exact false signal BRO-2951 exists to kill.
  for (const body of [
    JSON.stringify({ message: 'Required status check "test" is expected.' }),
    JSON.stringify({ message: 'Commits must have verified signatures.' }),
    JSON.stringify({ message: 'Reference does not exist' }),
    JSON.stringify({ message: 'Invalid request. "sha" is not a valid SHA.' }),
  ]) {
    const r = classifyRefUpdate({ status: 422, body });
    assert.equal(r.outcome, 'fatal', `expected fatal for ${body}`);
    assert.equal(isRetryable(r.outcome), false);
  }
});

test('403 secondary rate limit is throttled (retryable), not fatal', () => {
  // This is the error most likely to actually occur at 841-1210 commits/day,
  // because PATCH /git/refs is a content-mutating request. Routing it to
  // fatal abandons every remaining budgeted attempt on a transient condition.
  const r = classifyRefUpdate({
    status: 403,
    body: JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }),
  });
  assert.equal(r.outcome, 'throttled');
  assert.equal(isRetryable(r.outcome), true);
});

test('403 with a Retry-After header is throttled even when the body is unhelpful', () => {
  const r = classifyRefUpdate({ status: 403, body: '', retryAfter: '60' });
  assert.equal(r.outcome, 'throttled');
  assert.match(r.reason, /retry-after: 60/);
});

test('403 with no rate-limit signal is fatal (a real refusal)', () => {
  const r = classifyRefUpdate({
    status: 403,
    body: JSON.stringify({ message: 'Resource not accessible by integration' }),
  });
  assert.equal(r.outcome, 'fatal');
  assert.equal(isRetryable(r.outcome), false);
});

test('429 is throttled', () => {
  assert.equal(classifyRefUpdate({ status: 429 }).outcome, 'throttled');
});

test('409 is a race', () => {
  assert.equal(classifyRefUpdate({ status: 409, body: '' }).outcome, 'race');
});

test('5xx is timeout-bucketed (retryable), and 4xx auth/not-found is fatal', () => {
  for (const s of [500, 502, 503, 504]) {
    assert.equal(classifyRefUpdate({ status: s }).outcome, 'timeout', `HTTP ${s}`);
  }
  for (const s of [401, 404, 400, 451]) {
    assert.equal(classifyRefUpdate({ status: s, body: '' }).outcome, 'fatal', `HTTP ${s}`);
  }
});

test('a transport failure with no status is timeout, not fatal', () => {
  // gh-api-client.js throws this exact shape on its AbortController timeout.
  const r = classifyRefUpdate({
    errorMessage: 'GitHub API PATCH https://api.github.com/... -> timed out after 15000ms',
  });
  assert.equal(r.outcome, 'timeout');
  assert.equal(isRetryable(r.outcome), true);

  for (const msg of ['socket hang up', 'ECONNRESET', 'fetch failed', 'ETIMEDOUT']) {
    assert.equal(classifyRefUpdate({ errorMessage: msg }).outcome, 'timeout', msg);
  }
});

test('no status and an unrecognized error is fatal rather than silently retried', () => {
  const r = classifyRefUpdate({ errorMessage: 'TypeError: x is not a function' });
  assert.equal(r.outcome, 'fatal');
});

test('an empty input is fatal, never accidentally success', () => {
  // Guards the default: a caller that passes nothing must not be read as a
  // landed ref update.
  assert.equal(classifyRefUpdate().outcome, 'fatal');
  assert.equal(classifyRefUpdate({}).outcome, 'fatal');
});

test('reason is always a non-empty string and never leaks a whole body', () => {
  const huge = 'x'.repeat(5000);
  const r = classifyRefUpdate({ status: 400, body: huge });
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
  assert.ok(r.reason.length < 400, 'reason must stay log-sized');
});

test('isRetryable is exhaustive over the outcome set', () => {
  assert.equal(isRetryable('race'), true);
  assert.equal(isRetryable('throttled'), true);
  assert.equal(isRetryable('timeout'), true);
  assert.equal(isRetryable('fatal'), false);
  assert.equal(isRetryable('success'), false);
});
