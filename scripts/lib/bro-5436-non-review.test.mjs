// BRO-5436: three non-review pages sat as T1/T2 silent review gaps.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyGapCandidateUrl, classifyReviewUrl } = require('./non-review-url-patterns.js');
const { isChatReplyThread } = require('./talkinbroadway-forum-link.js');

test('recipe and TB regional-index pages are not gap candidates', () => {
  for (const u of [
    'https://www.thetimes.com/recipes/entertaining/party-food/article/dates-stuffed-with-labneh-tahini-and-hazelnuts-recipe-hxv7qhdhm',
    'https://www.talkinbroadway.com/regional/alb/',
    'https://www.talkinbroadway.com/regional/',
  ]) assert.strictEqual(classifyGapCandidateUrl(u).ok, false, u);
});

test('real Times and TB review URLs still count', () => {
  for (const u of [
    'https://www.thetimes.com/culture/theatre-dance/article/golden-boy-review-josh-oconnor-abc123',
    'https://www.talkinbroadway.com/page/ob/10_09_26.html',
  ]) assert.strictEqual(classifyReviewUrl(u).ok, true, u);
});

test('All That Chat "re:" replies are chat, announcement threads are not', () => {
  assert.strictEqual(isChatReplyThread('<html><title>All That Chat - re: Cosi Fan Tutte last night at the Met</title>'), true);
  assert.strictEqual(isChatReplyThread('<title>All That Chat - Hadestown review posted</title>'), false);
  assert.strictEqual(isChatReplyThread(''), false);
});
