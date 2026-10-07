import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSignature, buildActionUrl, verifySignature } = require('./autonomous-links.js');

const BASE = {
  action: 'approve',
  cardId: 'abc123-def456',
  branch: 'auto/fix-stale-flag',
  exp: 1770000000,
  secret: 'test-secret',
};

test('sign/verify round-trip succeeds', () => {
  const sig = buildSignature(BASE);
  assert.match(sig, /^[0-9a-f]{64}$/, 'HMAC-SHA256 hex');
  assert.equal(verifySignature({ ...BASE, sig }), true);
});

test('tampered sig fails', () => {
  const sig = buildSignature(BASE);
  const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  assert.equal(verifySignature({ ...BASE, sig: flipped }), false);
});

test('changed action invalidates', () => {
  const sig = buildSignature(BASE);
  assert.equal(verifySignature({ ...BASE, action: 'reject', sig }), false);
});

test('changed cardId invalidates', () => {
  const sig = buildSignature(BASE);
  assert.equal(verifySignature({ ...BASE, cardId: 'other-card', sig }), false);
});

test('changed branch invalidates', () => {
  const sig = buildSignature(BASE);
  assert.equal(verifySignature({ ...BASE, branch: 'auto/other-branch', sig }), false);
});

test('changed exp invalidates', () => {
  const sig = buildSignature(BASE);
  assert.equal(verifySignature({ ...BASE, exp: BASE.exp + 1, sig }), false);
});

test('URL contains all 5 params and the correct sig', () => {
  const url = buildActionUrl({ ...BASE, baseUrl: 'https://broadwayscorecard.com' });
  assert.ok(url.startsWith('https://broadwayscorecard.com/api/autonomous-action?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('card'), BASE.cardId);
  assert.equal(params.get('branch'), BASE.branch);
  assert.equal(params.get('action'), BASE.action);
  assert.equal(params.get('exp'), String(BASE.exp));
  assert.equal(params.get('sig'), buildSignature(BASE));
  // Round-trip: the sig from the URL verifies against the URL's own params.
  assert.equal(
    verifySignature({
      action: params.get('action'),
      cardId: params.get('card'),
      branch: params.get('branch'),
      exp: Number(params.get('exp')),
      secret: BASE.secret,
      sig: params.get('sig'),
    }),
    true
  );
});

test('junk sigs return false without throwing', () => {
  for (const junk of ['zz', 'deadbeef', '', 'zzzz'.repeat(16), 'g'.repeat(64), null, undefined, 42]) {
    assert.equal(verifySignature({ ...BASE, sig: junk }), false, `junk sig: ${JSON.stringify(junk)}`);
  }
});

// Buffer.from(_, 'hex') truncates at the first non-hex char, so a valid sig
// with trailing junk must NOT validate (ship-check 2026-07-13).
test('valid sig with appended non-hex chars is rejected', () => {
  const sig = buildSignature(BASE);
  assert.equal(verifySignature({ ...BASE, sig }), true, 'baseline valid');
  assert.equal(verifySignature({ ...BASE, sig: sig + 'TAMPER' }), false, 'trailing non-hex');
  assert.equal(verifySignature({ ...BASE, sig: sig + '00' }), false, 'trailing hex (wrong length)');
  assert.equal(verifySignature({ ...BASE, sig: sig.toUpperCase() }), false, 'uppercase hex not accepted');
});
