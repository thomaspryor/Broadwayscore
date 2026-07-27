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
const { _internal } = require('./brand-mention-serp.js');
const { isUnattributableSocialUrl, isNativelyCoveredUrl, parseXUrl } = _internal;

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
    'https://www.instagram.com/thomaspryor/', // owner handle listed in OWNER_ACCOUNTS.instagram
    'https://www.instagram.com/bwayscorecard#bio', // fragment suffix
    'https://m.facebook.com/broadwayscorecard/',
    'https://fb.me/bwayscorecard',
    'https://mobile.twitter.com/bwayscorecard/status/123',
    'https://links.broadwayscorecard.com/CL0/anything',
    'https://www.instagram.com/popular/bwayscorecard/',
    'https://www.instagram.com/stories/bwayscorecard/123456/',
    'https://www.instagram.com/_u/broadwayscorecard',
    'https://bsky.app/profile/broadwayscorecard.bsky.social/post/abc',
    'https://www.github.com/thomaspryor/Broadwayscore/issues/1',
  ];
  for (const url of owned) {
    assert.ok(isOwnerUrl(url), `expected owner URL: ${url}`);
  }
});

test('serp helpers handle subdomain variants and host-anchor correctly', () => {
  // Unattributable post URLs under variant subdomains are still skipped
  assert.ok(isUnattributableSocialUrl('https://secure.instagram.com/p/DAbC123/'));
  assert.ok(isUnattributableSocialUrl('https://www-fallback.instagram.com/reel/xyz/'));
  // Natively-covered platforms match on any subdomain…
  assert.ok(isNativelyCoveredUrl('https://mobile.twitter.com/someone/status/1'));
  assert.ok(isNativelyCoveredUrl('https://old.reddit.com/r/Broadway/'));
  // …but hosts merely ENDING in a platform domain must NOT be skipped
  assert.ok(!isNativelyCoveredUrl('https://www.netflix.com/title/123'));
  assert.ok(!isNativelyCoveredUrl('https://example.com/?share=https://x.com/foo'));
  // parseXUrl accepts mobile hosts
  assert.deepEqual(parseXUrl('https://mobile.twitter.com/somefan/status/42'), { handle: 'somefan', tweetId: '42' });
});

test('owner alias domains are classified as owner URLs (theaterscorecard leak 2026-07-27)', () => {
  const owned = [
    // The actual leaked mention: alias domain on the broadwayscore Vercel
    // project that mirrors the site (canonical → broadwayscorecard.com)
    'https://www.theaterscorecard.com/',
    'https://theaterscorecard.com/browse/best-recent-shows',
    'https://showscorecard.com/',
    'https://www.operascorecard.com/',
    'https://offbroadwayscorecard.com/show/primary-trust',
    'https://westendscorecard.com/west-end',
    'https://broadwaymetascore.com/',
    'https://www.scorekeep.co/',
    'https://eveandadammusical.com/',
    'https://broadwayscore.vercel.app/',
    'https://broadwayscore-git-main-thomaspryors-projects.vercel.app/show/hamilton',
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
    'https://www.instagram.com/explore/tags/broadwayscorecard/', // hashtag page = third-party UGC signal
    'https://bsky.app/profile/broadwayscorecardfan.bsky.social', // near-miss handle must NOT be swallowed
    'https://bsky.app/profile/thomaspryorlaw.bsky.social',
    'https://www.reddit.com/r/Broadway/comments/abc123/broadwayscorecard_is_great/',
    'https://www.nytimes.com/2026/07/01/theater/review-aggregators.html',
    'https://x.com/someoneelse/status/456',
    'https://www.netflix.com/broadwayscorecard', // host must not false-match *.x.com
    'https://mytheaterscorecard.com/', // prefixed host must NOT match the alias-domain pattern
    'https://theaterscorecards.com/', // near-miss domain (trailing s)
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
