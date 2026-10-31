/**
 * Tests for the brand-mention digest email gate.
 *
 * Owner email policy is ACTION-only (email-broadcast-rules): a run where the
 * drafter classified every mention as "no reply needed" must NOT email
 * (2026-07-27: a noise-only digest emailed one no-reply Google result of the
 * owner's own mirror domain). Verdict-less pairs (drafter skipped) count as
 * actionable so a drafter outage can't silently suppress real mentions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldSendDigest } = require('./brand-mention-email.js');

const noise = (over = {}) => ({ mention: { source: 'google' }, verdict: { shouldRespond: false, sentiment: 'neutral' }, ...over });
const respondable = () => ({ mention: { source: 'reddit' }, verdict: { shouldRespond: true, sentiment: 'positive' } });
const undrafted = () => ({ mention: { source: 'google' }, verdict: null });

test('empty or missing pairs → no email', () => {
  assert.equal(shouldSendDigest([]).send, false);
  assert.equal(shouldSendDigest(null).send, false);
});

test('all-noise run → no email (ACTION-only policy)', () => {
  const r = shouldSendDigest([noise(), noise()]);
  assert.equal(r.send, false);
  assert.match(r.reason, /no-reply noise/);
});

test('at least one respondable mention → email', () => {
  assert.equal(shouldSendDigest([noise(), respondable()]).send, true);
});

test('verdict-less pairs (drafter skipped) count as actionable → email', () => {
  assert.equal(shouldSendDigest([undrafted()]).send, true);
  assert.equal(shouldSendDigest([noise(), undrafted()]).send, true);
});

test('drafter-failure verdicts (draftError, shouldRespond:false) count as actionable → email', () => {
  // Drafter failure paths return a POPULATED verdict with shouldRespond:false,
  // not null — an LLM outage must not silently swallow mentions.
  const failed = { mention: { source: 'reddit' }, verdict: { shouldRespond: false, sentiment: 'neutral', draftError: true } };
  assert.equal(shouldSendDigest([failed]).send, true);
});

test('negative-sentiment no-reply mention (hostile article) still emails', () => {
  const hostile = { mention: { source: 'google' }, verdict: { shouldRespond: false, sentiment: 'negative' } };
  assert.equal(shouldSendDigest([hostile]).send, true);
});
