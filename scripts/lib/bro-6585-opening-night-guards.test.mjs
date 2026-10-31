// BRO-6585: A Few Good Men (2026) press-night defects. Each test pins one
// rule that kept a real review off the site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isBlockedReviewUrl } = require('./domain-filters.js');
const { extractDateFromUrl } = require('./rebuild-helpers.js');
const { recordFetchAttempt } = require('./review-guards.js');
const { classifyIncompleteReason } = require('./incomplete-reason.js');

test('Independent /features/ review is not blocked; interviews and roundups still are', () => {
  assert.equal(isBlockedReviewUrl('https://www.the-independent.com/arts-entertainment/theatre-dance/features/a-few-good-men-broadway-review-bradley-whitford-tom-blyth-b3075938.html'), false);
  assert.equal(isBlockedReviewUrl('https://www.the-independent.com/arts-entertainment/theatre-dance/features/bradley-whitford-a-few-good-men-b3070000.html'), true);
  assert.equal(isBlockedReviewUrl('https://example.com/features/broadway-review-roundup-a-few-good-men'), true);
  assert.equal(isBlockedReviewUrl('https://example.com/interview/a-few-good-men-review-chat'), true);
});

test('2026 WordPress and dash URL dates are read', () => {
  assert.equal(extractDateFromUrl('https://nystagereview.com/2026/10/29/a-few-good-men-built-to-last/').date, '2026-10-29');
  assert.equal(extractDateFromUrl('https://www.latimes.com/story/2026-10-29/a-few-good-men-review').date, '2026-10-29');
  assert.equal(extractDateFromUrl('https://example.com/reviews/1776-review'), null);
});

test('press-night fetch failure retries in 1h and is never abandoned inside 48h', () => {
  const now = Date.now();
  const show = { status: 'open', category: 'broadway', openingDate: new Date(now - 27 * 3600 * 1000).toISOString().slice(0, 10) };
  const p = recordFetchAttempt(show, {}, { failureReason: 'garbage_content', failureCount: 9 });
  assert.equal(p.fetchDiscoveryAbandoned, undefined);
  const wait = new Date(p.fetchRetryAfter).getTime() - now;
  assert.ok(wait > 50 * 60 * 1000 && wait <= 61 * 60 * 1000, `wait ${wait}`);
  const later = { ...show, openingDate: new Date(now - 5 * 86400 * 1000).toISOString().slice(0, 10) };
  const q = recordFetchAttempt(later, {}, { failureReason: 'timeout', failureCount: 1 });
  assert.ok(new Date(q.fetchRetryAfter).getTime() - now > 5 * 3600 * 1000);
});

// BRO-6679: the window runs 48h from the 9pm-ET publication moment, not from
// openingDate midnight UTC; fixed clock so it cannot flake by time of day.
test('press-night window is 48h from publication, deterministic', (t) => {
  const show = { status: 'open', category: 'broadway', openingDate: '2026-10-29' };
  const pub = Date.parse('2026-10-30T01:00:00Z'); // 9pm EDT on 10-29
  const run = (offsetH) => {
    t.mock.timers.enable({ apis: ['Date'], now: pub + offsetH * 3600 * 1000 });
    const p = recordFetchAttempt(show, {}, { failureReason: 'garbage_content', failureCount: 9 });
    t.mock.timers.reset();
    return p;
  };
  const inside = run(47);
  assert.equal(inside.fetchDiscoveryAbandoned, undefined);
  assert.equal(new Date(inside.fetchRetryAfter).getTime() - (pub + 47 * 3600 * 1000), 3600 * 1000);
  assert.equal(run(49).fetchDiscoveryAbandoned, true);
});

test('a failed fetch (retry stamped, no fetchMethod) is not "not_attempted"', () => {
  const r = classifyIncompleteReason({ url: 'https://www.thewrap.com/x-review/', contentTier: 'excerpt', fetchRetryAfter: new Date().toISOString() }, null);
  assert.notEqual(r && r.incompleteReason, 'not_attempted');
});
