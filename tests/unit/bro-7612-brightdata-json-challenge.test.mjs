/**
 * BRO-7612 — Bright Data's unlocker answered 1883magazine.com (Cloudflare) with a
 * 91-byte JSON body {"error":"challenge_required",...} as a 200. fetchPage reported
 * "Success (Bright Data)", the chain stopped before ScrapingBee (which reads the page),
 * and review submission #935 failed as "scraping failed".
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isChallengeOrGarbage, isProviderChallengeJson } = require('../../scripts/lib/scraper.js');

const BD = '{"error":"challenge_required","message":"Bot challenge required. Please reload the page."}';

test('Bright Data JSON challenge_required body is a challenge page', () => {
  assert.equal(isChallengeOrGarbage(BD), true);
  assert.equal(isChallengeOrGarbage(`  ${BD}\n`), true);
  assert.equal(isChallengeOrGarbage(`﻿${BD}`), true);
  assert.equal(isChallengeOrGarbage('{"error":{"code":"captcha_required"}}'), true);
  assert.equal(isChallengeOrGarbage('{"error":"blocked_request","message":"Bot challenge required."}'), true);
});

test('the same error wrapped in a browser <pre> view is a challenge page', () => {
  assert.equal(isChallengeOrGarbage(`<html><head></head><body><pre style="word-wrap: break-word;">${BD}</pre></body></html>`), true);
  assert.equal(isChallengeOrGarbage(`<pre>${BD.replace(/"/g, '&quot;')}</pre>`), true);
});

test('unrelated API errors, real JSON payloads and articles are not flagged', () => {
  for (const s of [
    '{"error":"not_found","message":"No post"}',
    '{"error":"Unblocked access granted"}',
    '{"error":"ip_blocked"}',
    '{"error":"recaptcha token invalid"}',
    '{"error":403,"message":"Forbidden"}',
    '{"code":"rest_post_invalid_id","message":"Invalid post ID.","data":{"status":404}}',
    '[{"id":1,"title":{"rendered":"Kimberly Akimbo"}}]',
    JSON.stringify({ data: [{ title: 'Kimberly Akimbo' }], error: null }),
  ]) assert.equal(isProviderChallengeJson(s), false, s);
  assert.equal(isChallengeOrGarbage(JSON.stringify({ content: { rendered: 'The bot challenge required of Kimberly is growing up. '.repeat(40) } })), false);
  const article = `<html><head><title>Kimberly Akimbo review</title></head><body><p>${'A big-hearted musical. '.repeat(60)}</p></body></html>`;
  assert.equal(isChallengeOrGarbage(article), false);
});
