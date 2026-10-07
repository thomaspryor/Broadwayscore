// Verdict logic of scripts/check-signin-redirects.mjs (BRO-4615). Requires the real module.
// Run: node --test scripts/check-signin-redirects.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeGoogle, judgeApple, exitCodeFor } from './check-signin-redirects.mjs';

const BASE = 'https://broadwayscorecard.com';
const AUTH = 'https://abc.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fbroadwayscorecard.com%2Fauth%2Fcallback';

test('Google passes only on a redirect to accounts.google.com', () => {
  assert.equal(judgeGoogle(AUTH, { status: 302, location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }).ok, true);
  assert.equal(judgeGoogle(null, null).ok, false, 'button did nothing');
  assert.equal(judgeGoogle(AUTH, { status: 400, location: '' }).ok, false, 'provider disabled in Supabase');
  assert.match(judgeGoogle(AUTH, { status: 302, location: 'https://broadwayscorecard.com/auth/callback#error=server_error' }).reason, /broadwayscorecard\.com/);
  assert.equal(judgeGoogle(AUTH, null).inconclusive, true, 'a timed-out hop never pages');
  assert.equal(judgeGoogle(AUTH, { status: 503, location: '' }).inconclusive, true);
  assert.equal(judgeGoogle(AUTH, { status: 400, location: '' }).inconclusive, undefined);
});

test('Apple passes only when our callback is the redirect and Apple shows its page', () => {
  const popup = `https://appleid.apple.com/auth/authorize?client_id=com.x&redirect_uri=${encodeURIComponent(BASE + '/auth/apple-callback')}&response_mode=web_message`;
  assert.equal(judgeApple(popup, { status: 200, body: '<html>Sign in with Apple</html>' }, BASE).ok, true);
  assert.equal(judgeApple(popup, { status: 200, body: '{"error":"invalid_request"}' }, BASE).ok, false);
  assert.equal(judgeApple(popup.replace('broadwayscorecard.com', 'www.broadwayscorecard.com'), { status: 200, body: '' }, BASE).ok, false);
  assert.equal(judgeApple(null, null, BASE).ok, false);
  assert.equal(judgeApple(popup, { status: 503, body: '' }, BASE).inconclusive, true);
  assert.equal(judgeApple(popup, { status: 429, body: '' }, BASE).inconclusive, true);
});

test('exit code: only a definite failure is 1; flaky or missing results are 2', () => {
  const ok = { ok: true }, bad = { ok: false }, flaky = { ok: false, inconclusive: true };
  assert.equal(exitCodeFor({ google: ok, apple: ok }), 0);
  assert.equal(exitCodeFor({ google: ok, apple: bad }), 1);
  assert.equal(exitCodeFor({ google: flaky, apple: bad }), 1);
  assert.equal(exitCodeFor({ google: ok, apple: flaky }), 2);
  assert.equal(exitCodeFor({ google: null, apple: null }), 2);
});
