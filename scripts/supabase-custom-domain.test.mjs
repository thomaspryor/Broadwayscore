// Pure decisions of scripts/supabase-custom-domain.mjs (BRO-4894). Requires the real module.
// Run: node --test scripts/supabase-custom-domain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHostname, relativeName, collectTxtRecords, judgeStatus, exitCodeFor, judgeGoogleRedirectProbe, redact, wantedRecords, nextStep, googleCallbackUrl, isNotConfigured, ACTIONS } from './supabase-custom-domain.mjs';

test('only one label under broadwayscorecard.com is accepted', () => {
  assert.equal(validateHostname('auth.broadwayscorecard.com'), 'auth');
  assert.equal(validateHostname('Auth.BroadwayScorecard.com.'), 'auth');
  for (const bad of ['broadwayscorecard.com', 'www.broadwayscorecard.com', 'auth.example.com', 'a.b.broadwayscorecard.com', 'evil.com/broadwayscorecard.com', '']) {
    assert.throws(() => validateHostname(bad), `${bad} should be refused`);
  }
});

test('TXT records are found whatever shape Supabase answers with, named relative to the zone', () => {
  const api = {
    data: {
      custom_hostname: 'auth.broadwayscorecard.com',
      status: '2_initiated',
      ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.auth.broadwayscorecard.com.', txt_value: 'ca3-abc ' }] },
      ownership_verification: { name: '_cf-custom-hostname.auth.broadwayscorecard.com', type: 'txt', value: 'own-123' },
      other: { name: 'auth.broadwayscorecard.com', type: 'CNAME', value: 'x.supabase.co' },
    },
  };
  assert.deepEqual(collectTxtRecords(api), [
    { name: '_acme-challenge.auth', type: 'TXT', value: 'ca3-abc' },
    { name: '_cf-custom-hostname.auth', type: 'TXT', value: 'own-123' },
  ]);
  assert.deepEqual(collectTxtRecords({ data: { status: '4_origin_setup_completed' } }), []);
  assert.equal(relativeName('_acme-challenge.auth.broadwayscorecard.com.'), '_acme-challenge.auth');
});

test('judgeStatus maps Supabase status strings to phases', () => {
  assert.equal(judgeStatus(null).phase, 'none');
  assert.equal(judgeStatus({ data: {} }).phase, 'none');
  assert.equal(judgeStatus({ data: { status: '2_initiated', ssl: { status: 'pending_validation' } } }).phase, 'pending');
  assert.equal(judgeStatus({ data: { status: '4_origin_setup_completed', ssl: { status: 'active' } } }).phase, 'verified');
  assert.equal(judgeStatus({ data: { status: '3_challenge_verified', ssl: { status: 'active' } } }).phase, 'verified');
  assert.equal(judgeStatus({ data: { status: '5_services_reconfigured', ssl: { status: 'active' } } }).phase, 'active');
  assert.equal(judgeStatus({ data: { status: '2_initiated', validation_errors: [{ message: 'CNAME missing' }] } }).phase, 'failed');
  assert.equal(judgeStatus({ data: { status: '3_challenge_verified', ssl: { status: 'validation_timed_out' } } }).phase, 'failed');
  // No data wrapper: the CLI prints the bare object.
  assert.equal(judgeStatus({ status: '5_services_reconfigured' }).phase, 'active');
  // The Management API shape: Supabase's numbered status at the top, the
  // Cloudflare envelope under data (success/errors/messages/result).
  const api = {
    status: '2_initiated',
    custom_hostname: 'auth.broadwayscorecard.com',
    data: { success: true, errors: [], messages: [], result: { id: 'cf1', hostname: 'auth.broadwayscorecard.com', ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.auth.broadwayscorecard.com', txt_value: 'v' }] }, ownership_verification: { type: 'txt', name: '_cf-custom-hostname.auth.broadwayscorecard.com', value: 'o' } } },
  };
  assert.equal(judgeStatus(api).phase, 'pending');
  assert.equal(judgeStatus({ ...api, status: '4_origin_setup_completed', data: { ...api.data, result: { ...api.data.result, ssl: { status: 'active' } } } }).phase, 'verified');
  assert.equal(judgeStatus({ ...api, data: { ...api.data, result: { ...api.data.result, ssl: { status: 'pending_validation', validation_errors: [{ message: 'TXT missing' }] } } } }).phase, 'failed');
  assert.equal(judgeStatus({ ...api, data: { ...api.data, result: { ...api.data.result, verification_errors: ['ownership TXT missing'] } } }).phase, 'failed');
  // The envelope alone (no numbered status) still counts as registered.
  assert.equal(judgeStatus({ data: { result: { hostname: 'auth.broadwayscorecard.com', ssl: { status: 'pending_validation' } } } }).phase, 'pending');
  assert.equal(collectTxtRecords(api).length, 2);
});

test('exit codes: 0 done, 1 broken or refused, 2 pending', () => {
  assert.equal(exitCodeFor('reverify', 'pending'), 2);
  assert.equal(exitCodeFor('reverify', 'verified'), 0);
  assert.equal(exitCodeFor('reverify', 'failed'), 1);
  assert.equal(exitCodeFor('activate', 'verified'), 1, 'activation that did not reach active is a failure');
  assert.equal(exitCodeFor('activate', 'active'), 0);
  assert.equal(exitCodeFor('delete', 'none'), 0);
  assert.equal(exitCodeFor('status', 'pending'), 0);
  assert.equal(exitCodeFor('create', 'active'), 0);
});

test('the Google probe refuses a redirect_uri_mismatch even on HTTP 200, and never passes a page it cannot read', () => {
  // Live 2026-10-09: Google served the error page with HTTP 200 and the old probe said "accepts".
  const errorPage200 = { status: 200, body: '<button data-response-code="400" data-error-code="redirect_uri_mismatch">error details</button> Error 400: redirect_uri_mismatch' };
  assert.equal(judgeGoogleRedirectProbe(errorPage200).ok, false);
  assert.equal(judgeGoogleRedirectProbe(errorPage200).inconclusive, undefined, 'a real mismatch is a verdict, not a shrug');
  assert.equal(judgeGoogleRedirectProbe({ status: 400, body: '<title>Error 400: redirect_uri_mismatch</title>' }).ok, false);
  assert.equal(judgeGoogleRedirectProbe({ status: 200, body: '<html>Choose an account to continue to auth.broadwayscorecard.com</html>' }).ok, true);
  assert.equal(judgeGoogleRedirectProbe({ status: 200, body: '<input id="identifierId">' }).ok, true);
  // Any other Google error page is a refusal too, even when it links the sign-in error route.
  const dead = judgeGoogleRedirectProbe({ status: 200, body: '<a href="https://accounts.google.com/signin/oauth/error?authError=x">Error 401: invalid_client</a>' });
  assert.equal(dead.ok, false);
  assert.equal(dead.inconclusive, undefined);
  const blank = judgeGoogleRedirectProbe({ status: 200, body: '<html>Your browser is not supported</html>' });
  assert.equal(blank.ok, false);
  assert.equal(blank.inconclusive, true, 'an unreadable page must not activate');
  assert.equal(judgeGoogleRedirectProbe({ status: 503, body: '' }).inconclusive, true);
  assert.equal(judgeGoogleRedirectProbe(null).inconclusive, true);
  assert.equal(judgeGoogleRedirectProbe({ status: 403, body: 'blocked' }).ok, false);
});

test('credentials never reach the log', () => {
  const out = redact({ access_token: 'x', nested: { service_role_key: 'y', apiKey: 'z', smtp_pass: 'p', fine: 'ok' }, list: [{ secret: 's' }] });
  assert.deepEqual(out, { access_token: '[redacted]', nested: { service_role_key: '[redacted]', apiKey: '[redacted]', smtp_pass: '[redacted]', fine: 'ok' }, list: [{ secret: '[redacted]' }] });
});

test('the next-step line names the Google callback when verified and never claims success while pending', () => {
  const host = 'auth.broadwayscorecard.com';
  assert.equal(googleCallbackUrl(host), 'https://auth.broadwayscorecard.com/auth/v1/callback');
  assert.match(nextStep('reverify', 'verified', host), /https:\/\/auth\.broadwayscorecard\.com\/auth\/v1\/callback/);
  assert.match(nextStep('reverify', 'verified', host), /ACTIVATE/);
  assert.match(nextStep('reverify', 'pending', host), /Nothing is broken/);
  assert.match(nextStep('dns', 'pending', host), /run create again/);
  assert.doesNotMatch(nextStep('reverify', 'pending', host), /Done/);
  assert.match(nextStep('activate', 'active', host), /Done/);
  assert.match(nextStep('create', 'failed', host), /Nothing changed for visitors/);
  assert.match(nextStep('delete', 'none', host), /back on the Supabase address/);
  assert.match(nextStep('status', 'none', host), /Run create/);
});

test('"No custom hostname configuration found." (HTTP 400, live 2026-10-09) means not set up, not broken', () => {
  assert.equal(isNotConfigured(400, { message: 'No custom hostname configuration found.' }), true);
  assert.equal(isNotConfigured(404, null), true);
  assert.equal(isNotConfigured(400, { message: 'invalid token' }), false);
  assert.equal(isNotConfigured(200, { status: '2_initiated' }), false);
});

test('wanted records: the CNAME points at the project host; actions are the documented set', () => {
  const w = wantedRecords('auth', 'abcdef', [{ name: '_acme-challenge.auth', type: 'TXT', value: 'v' }]);
  assert.equal(w[0].type, 'CNAME');
  assert.equal(w[0].value, 'abcdef.supabase.co');
  assert.equal(w[1].type, 'TXT');
  assert.deepEqual(ACTIONS, ['status', 'dns', 'initialize', 'reverify', 'activate', 'create', 'delete']);
});
