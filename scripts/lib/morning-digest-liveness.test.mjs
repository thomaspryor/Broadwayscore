import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideMorningDigest, CONDITION_KEY } = require('./morning-digest-liveness.js');
const { isPageWorthy } = require('./page-worthy-alerts.js');

const OWNER = 'owner@example.com';
// 11:30 UTC = 07:30 EDT on 2026-09-30
const digest = { to: [OWNER], subject: 'Morning digest — Wed Sep 30 · site ok · nothing needs you', created_at: '2026-09-30 11:30:05.123+00' };
const alert = { to: [OWNER], subject: 'CRITICAL: something', created_at: '2026-09-30 12:00:00+00' };
const other = { to: ['someone@else.com'], subject: 'Morning digest — Wed Sep 30', created_at: '2026-09-30 11:30:00+00' };
const call = (o) => decideMorningDigest({ ownerEmail: OWNER, dateET: '2026-09-30', ...o });

test('digest present today => ok', () => {
  assert.equal(call({ emails: [alert, digest] }).action, 'ok');
});
test('no emails => page', () => {
  assert.equal(call({ emails: [] }).action, 'page');
});
test('other owner emails and other recipients do not count as the digest', () => {
  assert.equal(call({ emails: [alert, other] }).action, 'page');
});
test('yesterday\'s digest does not satisfy today', () => {
  const y = { ...digest, created_at: '2026-09-29 11:30:00+00' };
  assert.equal(call({ emails: [y] }).action, 'page');
});
test('ET day boundary: 02:00 UTC on the 30th is still the 29th ET', () => {
  const late = { ...digest, created_at: '2026-09-30 02:00:00+00' };
  assert.equal(call({ emails: [late] }).action, 'page');
  assert.equal(call({ emails: [late], dateET: '2026-09-29' }).action, 'ok');
});
test('Resend API error => skip, never page', () => {
  const r = call({ emails: null, apiError: 'HTTP 401' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /HTTP 401/);
});
test('missing owner email / no list => skip', () => {
  assert.equal(decideMorningDigest({ emails: [], ownerEmail: '', dateET: '2026-09-30' }).action, 'skip');
  assert.equal(call({ emails: undefined }).action, 'skip');
});
test('the page key is on the page-worthy allowlist (else router downgrades it to digest)', () => {
  assert.equal(isPageWorthy(CONDITION_KEY), true);
});
