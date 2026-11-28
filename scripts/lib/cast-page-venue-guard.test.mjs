import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { validateCastPageContext, venueMentioned } = require('./cast-extraction-guards');

// BRO-5853: no same-title row existed, so another company's cast page passed unchecked.
const KOTY = { id: 'king-of-the-yees-off-broadway-2026', title: 'King of the Yees', venue: 'Signature Theatre Company/Alice Griffin Jewel Box Theater', openingDate: '2026-10-20' };

test('rejects a sibling-free title whose page never names the venue (Profile Theatre, Portland)', () => {
  const page = 'King of the Yees cast. Profile Theatre, Portland. Sandra Lee as Lauren Yee. Rob Narita as Larry Yee. Season 2026.';
  assert.deepEqual(validateCastPageContext(page, KOTY, [KOTY]), { ok: false, reason: 'unconfirmed-production-venue' });
});

test('accepts a page that names the venue', () => {
  const page = 'King of the Yees at the Pershing Square Signature Center. Francis Jue as Larry Yee.';
  assert.equal(validateCastPageContext(page, KOTY, [KOTY]).ok, true);
});

test('fails open when the venue has no distinctive word', () => {
  assert.equal(venueMentioned('any page', 'The Theatre'), true);
  assert.equal(venueMentioned('any page', ''), true);
});

test('accents fold and word boundaries hold', () => {
  assert.equal(venueMentioned('At the Théâtre Vaudeville tonight', 'Vaudeville Theatre'), true);
  assert.equal(venueMentioned('A signaturesque evening', 'Signature Theatre'), false);
});
