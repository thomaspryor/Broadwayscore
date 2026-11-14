// BRO-7131: abandoned "found but never fetched" reviews are retried, then escalated, never dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const r = require('./abandoned-review-rescue.js');

const show = { id: 'tosca-x', title: 'Tosca' };
const row = { file: 'tosca-x/bachtrack--a.json', show: 'tosca-x', outletId: 'bachtrack', recent: true, bucket: 'url_content_mismatch' };
const good = 'https://bachtrack.com/review-tosca-miskimmon-english-national-opera-london-october-2026';

test('a slug naming the show and "review" is a candidate', () => {
  assert.equal(r.candidate({ row, data: { url: good }, show, tier: 3, countedOutlets: new Set() }), null);
});

test('a review of another opera on the same site is not (Bachtrack site-search noise)', () => {
  const other = 'https://bachtrack.com/review-la-boheme-royal-opera-london-october-2026';
  assert.equal(r.candidate({ row, data: { url: other }, show, tier: 3 }).reason, 'slug-does-not-name-show');
});

test('every distinctive title word must appear', () => {
  assert.equal(r.slugNamesShowReview('https://x.com/review-golden-hour-2026', 'Golden Boy'), false);
  assert.equal(r.slugNamesShowReview('https://x.com/golden-boy-review-2026', 'Golden Boy'), true);
  assert.equal(r.slugNamesShowReview('https://x.com/golden-boy-interview', 'Golden Boy'), false);
});

test('tier 1-2, counted outlets, old shows and dead URLs are left to other paths', () => {
  assert.equal(r.candidate({ row, data: { url: good }, show, tier: 1 }).reason, 'tier-1-2-has-own-sweep');
  assert.equal(r.candidate({ row, data: { url: good }, show, tier: 3, countedOutlets: new Set(['bachtrack']) }).reason, 'outlet-already-counted');
  assert.equal(r.candidate({ row: { ...row, recent: false }, data: { url: good }, show, tier: 3 }).reason, 'not-recent');
  assert.equal(r.candidate({ row: { ...row, bucket: 'url_dead' }, data: { url: good }, show, tier: 3 }).reason, 'bucket:url_dead');
});

test('retry twice, spaced, then escalate once', () => {
  const now = Date.parse('2026-11-08T00:00:00Z');
  const ledger = {};
  assert.equal(r.decide(ledger.u, now), 'retry');
  r.recordAttempt(ledger, 'u', { show: 's' }, now);
  assert.equal(r.decide(ledger.u, now + 864e5), 'wait');
  assert.equal(r.decide(ledger.u, now + 30 * 864e5, 'bot_blocked'), 'escalate'); // block pages: one retry
  assert.equal(r.decide(ledger.u, now + r.RETRY_SPACING_DAYS * 864e5), 'retry');
  r.recordAttempt(ledger, 'u', {}, now + r.RETRY_SPACING_DAYS * 864e5);
  assert.equal(ledger.u.attempts, r.MAX_ATTEMPTS);
  assert.equal(ledger.u.show, 's');
  assert.equal(r.decide(ledger.u, now + 30 * 864e5), 'escalate');
  ledger.u.escalatedAt = '2026-12-01T00:00:00Z';
  assert.equal(r.decide(ledger.u, now + 30 * 864e5), 'escalated');
});
