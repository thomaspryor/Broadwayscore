/**
 * Tests for SERP recycled-snippet dedup in the brand-mention monitor.
 *
 * SERP engines (esp. Google on Threads/social profile pages) attach one
 * "sticky" snippet to every post URL under an account, so the same brand blurb
 * resurfaces under a fresh URL+title each day and slips past URL/title dedup.
 * The 2026-06-26 false positive: the blurb "Could Brandon Uranowitz split the
 * Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/
 * tony…" alerted 3x (Jun 7 Ragtime, Jun 23 Caissie Levy, Jun 26 Rhinoceros) —
 * three unrelated URLs, identical snippet. normalizeExcerpt + state.seenExcerpts
 * collapse it to one alert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _internal } = require('../../scripts/lib/brand-mention-serp.js');
const { normalizeExcerpt, canonicalizeUrl, urlHash } = _internal;
const { filterOwnerAccounts } = require('../../scripts/lib/owner-accounts.js');

test('normalizeExcerpt collapses the recurring Threads blurb to one key', () => {
  const a = 'Could Brandon Uranowitz split the Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/tony….';
  const b = 'Could Brandon Uranowitz split the Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/tony…';
  assert.equal(normalizeExcerpt(a), normalizeExcerpt(b));
  assert.ok(normalizeExcerpt(a).length > 0);
});

test('normalizeExcerpt strips relative-time prefix and Read more suffix', () => {
  const withPrefix = '3 hours ago — Do you have a favorite supporting performance this season? broadwayscorecard.com/tony…Read more';
  const bare = 'Do you have a favorite supporting performance this season? broadwayscorecard.com/tony';
  assert.equal(normalizeExcerpt(withPrefix), normalizeExcerpt(bare));
});

test('normalizeExcerpt is case- and whitespace-insensitive', () => {
  assert.equal(
    normalizeExcerpt('Check  OUT   broadwayscorecard.com'),
    normalizeExcerpt('check out broadwayscorecard.com')
  );
});

test('normalizeExcerpt returns empty for falsy/blank input', () => {
  assert.equal(normalizeExcerpt(''), '');
  assert.equal(normalizeExcerpt(null), '');
  assert.equal(normalizeExcerpt(undefined), '');
  assert.equal(normalizeExcerpt('   …  '), '');
});

test('distinct snippets keep distinct keys (no over-collapse)', () => {
  const ragtime = normalizeExcerpt('Joshua Henry and RAGTIME cast celebrate 11 Tony nominations — broadwayscorecard.com');
  const tony = normalizeExcerpt('Could Brandon Uranowitz split the Best Actor vote? broadwayscorecard.com/tony…');
  assert.notEqual(ragtime, tony);
});

// Mirrors the monitor's dedup decision: SERP snippet seen in prior state OR
// earlier this run is a duplicate; free-source mentions are exempt.
function isExcerptDup(mention, seenExcerpts, seenThisRun, serpSources) {
  if (!serpSources.has(mention.source)) return false;
  const norm = normalizeExcerpt(mention.excerpt);
  if (!norm) return false;
  return Boolean(seenExcerpts[norm]) || seenThisRun.has(norm);
}

test('recycled SERP snippet under a new URL is a cross-run duplicate', () => {
  const SERP = new Set(['google', 'news']);
  const blurb = 'Could Brandon Uranowitz split the Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/tony….';
  const seenExcerpts = { [normalizeExcerpt(blurb)]: true };

  const todayRhinoceros = {
    source: 'google',
    url: 'https://www.threads.com/@officialbroadwayworld/post/DaAvDVREUED/a-r-t-rhinoceros/',
    title: 'ART has announced the full cast and creative team for Rhinoceros!',
    excerpt: blurb,
  };
  assert.equal(isExcerptDup(todayRhinoceros, seenExcerpts, new Set(), SERP), true);
});

test('free-source mention with same text is NOT deduped by excerpt', () => {
  const SERP = new Set(['google', 'news']);
  const blurb = 'love broadwayscorecard.com for tracking reviews';
  const seenExcerpts = { [normalizeExcerpt(blurb)]: true };
  const redditPost = { source: 'reddit', url: 'https://reddit.com/r/Broadway/x', title: 't', excerpt: blurb };
  assert.equal(isExcerptDup(redditPost, seenExcerpts, new Set(), SERP), false);
});

// 2026-07-22 false positive: Google re-surfaced the same Caissie Levy Threads
// post (first seen Jun 23 with a slugged URL) under the bare /post/{id} URL, and
// prefixed the recycled snippet with an absolute date ("Jun 9, 2026 — ") that
// the relative-time regex didn't strip — both dedup layers missed.
test('normalizeExcerpt strips absolute-date prefix (Jun 9, 2026 —)', () => {
  const dated = 'Jun 9, 2026 — Could Brandon Uranowitz split the Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/tony….Read more';
  const bare = 'Could Brandon Uranowitz split the Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/tony….';
  assert.equal(normalizeExcerpt(dated), normalizeExcerpt(bare));
});

test('canonicalizeUrl collapses Threads slugged/bare post URL variants', () => {
  const slugged = 'https://www.threads.com/@officialbroadwayworld/post/DZXM95eEfVh/caissie-levy-took-home-a-tony-award-best-performance-by-an-actress-in-a-leading/';
  const bare = 'https://www.threads.com/@officialbroadwayworld/post/DZXM95eEfVh';
  assert.equal(canonicalizeUrl(slugged), canonicalizeUrl(bare));
  assert.equal(urlHash(slugged), urlHash(bare));
  // threads.net and threads.com are the same site
  assert.equal(
    canonicalizeUrl('https://threads.net/@x/post/ABC123/slug-here/'),
    canonicalizeUrl('https://www.threads.com/@x/post/ABC123')
  );
  // Different posts stay distinct
  assert.notEqual(canonicalizeUrl(bare), canonicalizeUrl('https://www.threads.com/@officialbroadwayworld/post/DZw9ryQlGbA'));
});

test('owner Threads reply-comments under third-party posts are filtered as owner content', () => {
  const mentions = [
    {
      source: 'google', author: null,
      url: 'https://www.threads.com/@keepitmovingkt/post/DZU_3DTjp8f/last-night-was-the-th-annual-tony-awards/',
      title: 'Last night was the 79th Annual Tony Awards, the best of ...',
      excerpt: 'Jun 8, 2026 — Could Brandon Uranowitz split the Best Actor vote? Check out more Tony predictions at broadwayscorecard.com/tony….Read more',
    },
    {
      source: 'google', author: null,
      url: 'https://www.threads.com/@bwayscorecard/post/DZF-lb-FXVe',
      title: 'bwayscorecard on Threads',
      excerpt: 'Check out what audiences thought of all of the nominated revivals! broadwayscorecard.com/tony…',
    },
  ];
  const { kept, dropped } = filterOwnerAccounts(mentions);
  assert.equal(dropped.length, 2);
  assert.equal(kept.length, 0);
});

test('genuine third-party recommendation is NOT owner-filtered', () => {
  const mentions = [{
    source: 'google', author: null,
    url: 'https://www.threads.com/@somefan/post/XYZ789',
    title: 'best broadway review site',
    excerpt: 'I always check broadwayscorecard.com before buying tickets, great critic roundups',
  }];
  const { kept, dropped } = filterOwnerAccounts(mentions);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('genuinely new SERP snippet passes through', () => {
  const SERP = new Set(['google', 'news']);
  const fresh = { source: 'google', url: 'https://example.com/x', title: 't', excerpt: 'A brand new review citing broadwayscorecard.com today' };
  assert.equal(isExcerptDup(fresh, {}, new Set(), SERP), false);
});
