/**
 * Tests for OWNER_URL_PATTERNS in the brand-mention owner filter.
 *
 * Three real Google-SERP leaks alerted the owner about their own Instagram
 * (all present in data/audit/brand-mentions.json):
 *   2026-04-17  https://secure.instagram.com/bwayscorecard/?hl=bg
 *   2026-06-27  https://www-fallback.instagram.com/bwayscorecard/
 *   2026-07-26  https://www.instagram.com/popular/broadway-scorecard/
 * The first two dodged the (?:www\.)?-anchored subdomain; the third is
 * Instagram's auto-generated topic page, a different path entirely. These
 * tests pin the loosened subdomain matching and the topic-page pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isOwnerUrl, filterOwnerAccounts } = require('./owner-accounts.js');

test('real leaked SERP URLs are classified as owner URLs', () => {
  const leaked = [
    'https://secure.instagram.com/bwayscorecard/?hl=bg',
    'https://www-fallback.instagram.com/bwayscorecard/',
    'https://www.instagram.com/popular/broadway-scorecard/',
  ];
  for (const url of leaked) {
    assert.ok(isOwnerUrl(url), `expected owner URL: ${url}`);
  }
});

test('subdomain variants of owner profiles match across platforms', () => {
  const owned = [
    'https://instagram.com/broadwayscorecard',
    'https://m.facebook.com/broadwayscorecard/',
    'https://mobile.twitter.com/bwayscorecard/status/123',
    'https://links.broadwayscorecard.com/CL0/anything',
    'https://www.instagram.com/explore/tags/broadwayscorecard/',
    'https://www.instagram.com/popular/bwayscorecard/',
  ];
  for (const url of owned) {
    assert.ok(isOwnerUrl(url), `expected owner URL: ${url}`);
  }
});

test('genuine third-party URLs still pass through', () => {
  const thirdParty = [
    'https://www.instagram.com/p/DAbCdEfGhIj/', // opaque post URL — resolved by drafter, not URL filter
    'https://www.instagram.com/broadwayworld/',
    'https://www.instagram.com/popular/broadway-shows/',
    'https://www.reddit.com/r/Broadway/comments/abc123/broadwayscorecard_is_great/',
    'https://www.nytimes.com/2026/07/01/theater/review-aggregators.html',
    'https://x.com/someoneelse/status/456',
    'https://www.netflix.com/broadwayscorecard', // host must not false-match *.x.com
  ];
  for (const url of thirdParty) {
    assert.ok(!isOwnerUrl(url), `expected third-party URL to pass: ${url}`);
  }
});

test('filterOwnerAccounts drops SERP mentions of leaked owner URLs (no author field)', () => {
  const mentions = [
    { source: 'google', author: null, url: 'https://www.instagram.com/popular/broadway-scorecard/', title: 'Broadway Scorecard - Instagram', excerpt: 'BroadwayScorecard is a review aggregator…' },
    { source: 'google', author: null, url: 'https://secure.instagram.com/bwayscorecard/?hl=bg', title: '(@bwayscorecard)', excerpt: '' },
    { source: 'reddit', author: 'some_theater_fan', url: 'https://www.reddit.com/r/Broadway/comments/xyz/', title: 'Has anyone used broadwayscorecard?', excerpt: 'Found this site…' },
  ];
  const { kept, dropped } = filterOwnerAccounts(mentions);
  assert.equal(dropped.length, 2);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].author, 'some_theater_fan');
});
