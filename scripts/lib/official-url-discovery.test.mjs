import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBlockedDomain, scoreCandidate, buildSearchQuery } = require('./official-url-discovery.js');

// Extracted from enrich-official-urls.js (BRO-166) so ob-discovery-ticket-links.js
// can reuse the same logic — these pin the extraction didn't change behavior.

test('isBlockedDomain: ticket platforms and aggregators are blocked', () => {
  assert.equal(isBlockedDomain('https://www.todaytix.com/nyc/shows/1'), true);
  assert.equal(isBlockedDomain('https://playbill.com/article/x'), true);
  assert.equal(isBlockedDomain('https://sub.broadwayworld.com/x'), true);
});

test('isBlockedDomain: a dedicated show site is not blocked', () => {
  assert.equal(isBlockedDomain('https://www.hamiltonmusical.com'), false);
});

test('scoreCandidate: domain containing the show title scores highly', () => {
  const score = scoreCandidate('https://www.somemusical.com', 'Some Musical — Official Site', 'Some Musical');
  assert.ok(score >= 5, `expected high score, got ${score}`);
});

test('scoreCandidate: unrelated domain/title scores low', () => {
  const score = scoreCandidate('https://randomblog.example.com', 'Unrelated blog post', 'Some Musical');
  assert.ok(score <= 1, `expected low score, got ${score}`);
});

test('buildSearchQuery: off-broadway show gets "broadway" market term (no dedicated west-end distinction)', () => {
  const q = buildSearchQuery({ title: 'Test Show', category: 'off-broadway' });
  assert.match(q, /broadway/);
  assert.match(q, /official website/);
});

test('buildSearchQuery: west-end show gets "west end" market term', () => {
  const q = buildSearchQuery({ title: 'Test Show', category: 'west-end' });
  assert.match(q, /west end/);
});
