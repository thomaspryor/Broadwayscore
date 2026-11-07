/**
 * BRO-4656: tour-stop discovery tried to ingest a www.threads.com post as a
 * review. Google now returns threads.com as well as threads.net (same site),
 * so both must be blocked as social, along with Bluesky.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isBlockedReviewUrl, isSocialMediaUrl } = require('../../scripts/lib/domain-filters.js');

test('threads.com, threads.net and bsky.app are social, never reviews', () => {
  for (const url of [
    'https://www.threads.com/@roughdraftatl/post/ABC123',
    'https://threads.net/@x/post/ABC',
    'https://bsky.app/profile/someone.bsky.social/post/3k',
  ]) {
    assert.equal(isSocialMediaUrl(url), true, url);
    assert.equal(isBlockedReviewUrl(url), true, url);
  }
});

test('a real local review is not blocked', () => {
  assert.equal(isBlockedReviewUrl('https://roughdraftatlanta.com/2025/07/24/review-spamalot-fox-theatre/'), false);
});
