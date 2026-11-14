// checkRedirect mirrors GoTrue's redirect rule (BRO-4525). The old check was a
// substring test, so a list holding only demo.broadwayscorecard.com reported
// broadwayscorecard.com as allowed too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRedirect, parseAllowList } from '../../scripts/lib/auth-redirect-allowlist.mjs';

// The live allowlist as logged by test-ugc-roundtrip.yml on 2026-10-02.
const LIVE = 'https://broadwayscorecard.com/auth/callback,https://demo.broadwayscorecard.com/auth/callback,http://localhost:3000/auth/callback,http://localhost:3456/auth/callback,https://*.vercel.app/auth/callback';
const SITE = 'https://broadwayscorecard.com/';
const PROD = 'https://broadwayscorecard.com/auth/callback';
const DEMO = 'https://demo.broadwayscorecard.com/auth/callback';

test('live config allows both prod and demo callbacks', () => {
  assert.deepEqual(checkRedirect(PROD, { siteUrl: SITE, allowList: LIVE }), { allowed: true, via: 'site_url' });
  const demo = checkRedirect(DEMO, { siteUrl: SITE, allowList: LIVE });
  assert.equal(demo.allowed, true);
  assert.equal(demo.entry, DEMO);
});

test('a demo-only allowlist does not cover prod (the substring bug)', () => {
  const r = checkRedirect(PROD, { siteUrl: 'https://demo.broadwayscorecard.com', allowList: DEMO });
  assert.equal(r.allowed, false);
});

test('prod is allowed through site_url with an empty allowlist', () => {
  assert.equal(checkRedirect(PROD, { siteUrl: SITE, allowList: '' }).allowed, true);
});

test('single * stops at dots and slashes', () => {
  const allowList = 'https://*.vercel.app/auth/callback';
  assert.equal(checkRedirect('https://bsc-git-x.vercel.app/auth/callback', { siteUrl: SITE, allowList }).allowed, true);
  assert.equal(checkRedirect('https://a.b.vercel.app/auth/callback', { siteUrl: SITE, allowList }).allowed, false);
  assert.equal(checkRedirect('https://evil.com/x.vercel.app/auth/callback', { siteUrl: SITE, allowList }).allowed, false);
});

test('** crosses separators; literal dots are not wildcards', () => {
  assert.equal(checkRedirect('https://a.b.example.com/x/y', { siteUrl: SITE, allowList: 'https://**.example.com/**' }).allowed, true);
  assert.equal(checkRedirect('https://demoXbroadwayscorecard.com/auth/callback', { siteUrl: SITE, allowList: DEMO }).allowed, false);
});

test('entries are trimmed and blanks dropped', () => {
  assert.deepEqual(parseAllowList(' a , ,b,'), ['a', 'b']);
  assert.deepEqual(parseAllowList(undefined), []);
});
