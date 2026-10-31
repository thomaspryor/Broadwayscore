// tests/unit/cookie-health-live-route.test.mjs — BRO-5566.
//
// check-cookie-health.js Layer 3 paged on thestage + thetimes every run while
// both logins were valid: the ScrapingBee premium route never carries either
// session. These tests pin the fix: thestage probes the production
// cookies-plain route with the shared classifyWalledProbe() verdict, and
// thetimes (no CI route can authenticate it) warns with the reason instead of
// failing. Drives the real module (CLAUDE.md §15); fetch is stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// cookie-loader reads individual cookie env vars as base64 JSON.
process.env.THESTAGE_COOKIES = Buffer.from(JSON.stringify([
  { name: 'USER', value: 'u', domain: '.thestage.co.uk' },
  { name: 'USERSECURE', value: 's', domain: '.thestage.co.uk' },
])).toString('base64');
const health = require('../../scripts/check-cookie-health.js');
const { COOKIE_PROBES } = require('../../scripts/lib/cookie-probes.js');

const stage = health.CRITICAL_OUTLETS.thestage;
// Minimal shape extractStageBody() reads: IntroText start, then <p> prose.
const para = (n) => `<p>Paragraph ${n} of the logged-in review, long enough to count as real prose for the extractor.</p>`;
const article = `<html><body><div class="aos-Article-IntroText">Standfirst</div>${[1, 2, 3, 4, 5, 6].map(para).join('')}</body></html>`;
const gate = '<html><body><div class="aos-Article-IntroText">Standfirst</div><p>Create a free account to read 5 free articles <a href="/register?utm_source=Reggate">Register</a></p></article></body></html>';
const challenge = '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';

function stubFetch(withCookiesHtml, withoutCookiesHtml) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const hasCookie = !!(opts.headers && opts.headers.Cookie);
    seen.push(hasCookie);
    const html = hasCookie ? withCookiesHtml : withoutCookiesHtml;
    return { ok: true, status: 200, text: async () => html };
  };
  return seen;
}

test('thestage Layer 3 uses the cookie-plain production route with the shared probe markers', () => {
  assert.equal(stage.liveRoute, 'cookie-plain');
  assert.equal(stage.testUrl, COOKIE_PROBES.thestage.url);
  assert.equal(stage.gateMarker, COOKIE_PROBES.thestage.gateMarker);
  assert.equal(stage.wallMarker, COOKIE_PROBES.thestage.wallMarker);
});

test('thetimes Layer 3 is a documented CI skip, not a ScrapingBee fetch', () => {
  assert.match(health.CRITICAL_OUTLETS.thetimes.ciLiveUnverifiable, /recover-thetimes-browser\.js --auth-only/);
});

test('logged-in session passes (full body with cookies, gate without)', async () => {
  const seen = stubFetch(article, gate);
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'pass', r.message);
  assert.deepEqual(seen.sort(), [false, true], 'one fetch with cookies, one zero-cookie control');
});

test('dead session fails (registration gate served with cookies)', async () => {
  stubFetch(gate, gate);
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'fail', r.message);
  assert.match(r.message, /Logged out/);
});

test('unrecognised page (challenge from a CI IP) warns, never fails', async () => {
  stubFetch(challenge, challenge);
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'warn', r.message);
});

test('probe URL readable without cookies warns as vacuous', async () => {
  stubFetch(article, article);
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /VACUOUS/);
});

test('HTTP error warns (network/IP block is not a cookie verdict)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /probe error/);
});

test('logout still fails when the zero-cookie control is blocked (403)', async () => {
  globalThis.fetch = async (url, opts) => (opts.headers.Cookie
    ? { ok: true, status: 200, text: async () => gate }
    : { ok: false, status: 403, text: async () => '' });
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'fail', r.message);
});

test('logout still fails when the control is a challenge page', async () => {
  stubFetch(gate, challenge);
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'fail', r.message);
});

test('gate page with enough teaser prose to clear the floor still fails', async () => {
  const teaserGate = article.replace('</body>', '<a href="/register?utm_source=Reggate">Register</a></body>');
  stubFetch(teaserGate, gate);
  const r = await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.equal(r.status, 'fail', r.message);
});

test('with-cookies leg sends the production cookies-plain headers', async () => {
  let cookieReq;
  globalThis.fetch = async (url, opts) => {
    if (opts.headers.Cookie) cookieReq = opts.headers;
    return { ok: true, status: 200, text: async () => article };
  };
  await health.checkLiveAccessWalledPlain(stage.testUrl, { ...stage, minBodyChars: 200 });
  assert.match(cookieReq.Cookie, /USER=u/);
  assert.equal(cookieReq['Sec-Fetch-Mode'], 'navigate', 'fetchWithCookiesPlain headers, not a lookalike');
});

test('walledVerdictToResult: only logged-out fails', () => {
  assert.equal(health.walledVerdictToResult('logged-in', 3000, 0, 1200).status, 'pass');
  assert.equal(health.walledVerdictToResult('logged-out', 0, 0, 1200).status, 'fail');
  assert.equal(health.walledVerdictToResult('vacuous', 3000, 3000, 1200).status, 'warn');
  assert.equal(health.walledVerdictToResult('error', 0, 0, 1200).status, 'warn');
});
