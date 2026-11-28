import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkWsjOtpFreshness, WSJ_OTP_WARN_DAYS, WSJ_OTP_FAIL_DAYS } = require('./wsj-otp-freshness.js');

const NOW = 1785700000; // fixed anchor, 2026-08-02-ish
const otp = (overrides) => ({ method: 'otp-login', ...overrides });

test('no meta at all -> fail (launchd job may have never run)', () => {
  const r = checkWsjOtpFreshness(null, NOW);
  assert.equal(r.status, 'fail');
  assert.match(r.message, /never run/);
});

test('meta with wrong/missing method (e.g. Safari-extraction bundle _meta) -> warn, not pass/fail', () => {
  const r = checkWsjOtpFreshness({ extractedAtUnix: NOW - 86400 }, NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /not sourced from OTP-login/);
});

test('otp-login meta with no extractedAt/extractedAtUnix -> fail', () => {
  const r = checkWsjOtpFreshness(otp({}), NOW);
  assert.equal(r.status, 'fail');
  assert.match(r.message, /no valid timestamp/);
});

test('malformed extractedAtUnix (non-numeric) falls back, or fails rather than reading as fresh', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: '2020-01-01' }), NOW);
  assert.notEqual(r.status, 'pass');
  assert.match(r.message, /no valid timestamp/);
});

test('fresh extraction (1 day ago) -> pass', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW - 86400 }), NOW);
  assert.equal(r.status, 'pass');
  assert.equal(r.ageDays, 1);
});

test('just under WARN threshold -> pass', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW - (WSJ_OTP_WARN_DAYS - 1) * 86400 }), NOW);
  assert.equal(r.status, 'pass');
});

test('exactly at WARN threshold (40d) -> warn', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW - WSJ_OTP_WARN_DAYS * 86400 }), NOW);
  assert.equal(r.status, 'warn');
  assert.equal(r.ageDays, WSJ_OTP_WARN_DAYS);
});

test('between WARN and FAIL -> warn', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW - 55 * 86400 }), NOW);
  assert.equal(r.status, 'warn');
});

test('exactly at FAIL threshold (70d) -> fail', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW - WSJ_OTP_FAIL_DAYS * 86400 }), NOW);
  assert.equal(r.status, 'fail');
  assert.match(r.message, /launchd job likely dead/);
});

test('way past FAIL -> fail', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW - 200 * 86400 }), NOW);
  assert.equal(r.status, 'fail');
});

test('extractedAt ISO string fallback (no extractedAtUnix) is honored', () => {
  const isoDate = new Date((NOW - 5 * 86400) * 1000).toISOString();
  const r = checkWsjOtpFreshness(otp({ extractedAt: isoDate }), NOW);
  assert.equal(r.status, 'pass');
  assert.equal(r.ageDays, 5);
});

test('future extractedAt (clock skew / corrupt meta) -> warn, not pass or fail', () => {
  const r = checkWsjOtpFreshness(otp({ extractedAtUnix: NOW + 2 * 86400 }), NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /future/);
});
