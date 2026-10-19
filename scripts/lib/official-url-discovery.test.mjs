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

// BRO-5343: a title-only match attached another production's site to two London rows.
const { domainMatchesTitle } = require('./official-url-discovery.js');
const { isBlockedOfficialUrl } = require('./official-url-discovery.js');

test('isBlockedOfficialUrl: listing and ticket sites remain blocked, including subdomains', () => {
  for (const url of [
    'https://www.newyorktheatreguide.com/',
    'https://www.broadway.org/shows/fallen-angels',
    'https://tickets.newyorktheatreguide.com/show',
    'https://www.todaytix.com/nyc/shows/1',
    'https://playbill.com/article/x',
  ]) assert.equal(isBlockedOfficialUrl(url), true, url);
});

test('isBlockedOfficialUrl: known venue hosts are allowed without changing SERP filtering', () => {
  for (const url of ['https://irishrep.org/', 'https://www.lct.org/shows/ragtime/', 'https://tickets.signaturetheatre.org/']) {
    assert.equal(isBlockedDomain(url), true, `SERP must still exclude ${url}`);
    assert.equal(isBlockedOfficialUrl(url), false, url);
  }
  assert.equal(isBlockedOfficialUrl('https://www.hamiltonmusical.com/'), false);
  assert.equal(isBlockedOfficialUrl('https://irishrep.org.newyorktheatreguide.com/'), true);
});

test('domainMatchesTitle: Peter Pan does not take Peter Pan Goes Wrong', () => {
  assert.equal(domainMatchesTitle('https://pangoeswrongbway.com/', 'Peter Pan', 'off-west-end'), false);
  assert.equal(domainMatchesTitle('https://pangoeswrongbway.com/', 'Peter Pan', 'broadway'), false);
});

test('domainMatchesTitle: a London play does not take a "<title>broadway" site', () => {
  assert.equal(domainMatchesTitle('https://babybroadway.co.uk/', 'Baby', 'off-west-end'), false);
});

test('domainMatchesTitle: genuine show sites still match', () => {
  assert.equal(domainMatchesTitle('https://www.hamiltonmusical.com', 'Hamilton', 'broadway'), true);
  assert.equal(domainMatchesTitle('https://www.hadestown.com', 'Hadestown', 'west-end'), true);
  assert.equal(domainMatchesTitle('https://www.somemusical.com', 'Some Musical', 'broadway'), true);
});
