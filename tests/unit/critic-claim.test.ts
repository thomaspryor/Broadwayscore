/**
 * BRO-6895: signed approve/decline links and the "critics can never change
 * scores" guard. Requires the real helpers (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signClaimLink, verifyClaimLink, sanitizeProfileEdit, sanitizeClaimInput, CLAIM_LINK_TTL_SECONDS } from '../../src/lib/critic-claim';

const SECRET = 'test-secret';
const ID = '11111111-2222-3333-4444-555555555555';
const params = (l: ReturnType<typeof signClaimLink>) => ({ c: l.c, a: l.a, e: String(l.e), s: l.s });

test('a signed link verifies and carries its action', () => {
  const r = verifyClaimLink(SECRET, params(signClaimLink(SECRET, 'approve', ID)));
  assert.deepEqual(r, { ok: true, action: 'approve', claimId: ID });
});

test('approve signature cannot be reused as decline, or for another claim', () => {
  const l = signClaimLink(SECRET, 'approve', ID);
  assert.equal(verifyClaimLink(SECRET, { ...params(l), a: 'decline' }).ok, false);
  assert.equal(verifyClaimLink(SECRET, { ...params(l), c: ID.replace('1', '2') }).ok, false);
});

test('wrong secret, tampered expiry, expired, malformed and missing secret are refused', () => {
  const l = signClaimLink(SECRET, 'approve', ID, 1_000_000);
  assert.equal(verifyClaimLink('other', params(l), 1_000_000).ok, false);
  assert.equal(verifyClaimLink(SECRET, { ...params(l), e: String(l.e + 99999) }, 1_000_000).ok, false);
  const late = verifyClaimLink(SECRET, params(l), 1_000_000 + (CLAIM_LINK_TTL_SECONDS + 5) * 1000);
  assert.deepEqual(late, { ok: false, reason: 'expired' });
  assert.equal(verifyClaimLink(SECRET, { ...params(l), s: 'zz' }).ok, false);
  assert.equal(verifyClaimLink(undefined, params(l)).ok, false);
  assert.equal(verifyClaimLink(SECRET, { c: 'nope', a: 'approve', e: '1', s: l.s }).ok, false);
});

test('profile edit keeps only allow-listed fields: score fields in the body change nothing', () => {
  const body = {
    bio: 'Covers new musicals.', jobTitle: 'Chief critic',
    score: 100, avgScore: 100, reviewCount: 9999, volumeRank: 1, generosityRank: 1,
    reviews: [{ reviewScore: 100 }], reviewScore: 100, removeReviews: true, user_id: 'x', verified_at: 'x',
  };
  const out = sanitizeProfileEdit(body, new Set());
  assert.deepEqual(Object.keys(out).sort(), ['bio', 'jobTitle', 'links', 'outlets', 'picks', 'pinnedReviewKey']);
  assert.equal(JSON.stringify(out).includes('100'), false);
  assert.equal(out.bio, 'Covers new musicals.');
});

test('bio is capped at 300, links must be http(s), pinned review must be their own', () => {
  const out = sanitizeProfileEdit({
    bio: 'x'.repeat(500),
    links: [{ label: 'Site', url: 'https://example.com' }, { label: 'Bad', url: 'javascript:alert(1)' }, { label: '', url: 'https://a.com' }],
    pinnedReviewKey: 'someone-elses',
  }, new Set(['mine']));
  assert.equal(out.bio?.length, 300);
  assert.deepEqual(out.links, [{ label: 'Site', url: 'https://example.com/' }]);
  assert.equal(out.pinnedReviewKey, null);
  assert.equal(sanitizeProfileEdit({ pinnedReviewKey: 'mine' }, new Set(['mine'])).pinnedReviewKey, 'mine');
});

test('non-object bodies yield an empty profile, not a throw', () => {
  for (const b of [null, undefined, 'x', 7, []]) {
    const out = sanitizeProfileEdit(b, new Set());
    assert.equal(out.bio, null);
    assert.deepEqual(out.links, []);
  }
});

test('claim input validates slug, email and work link', () => {
  assert.deepEqual(sanitizeClaimInput({ slug: 'jordan-ellis', contactEmail: 'j@e.com', workUrl: '', note: ' hi ' }), { slug: 'jordan-ellis', contactEmail: 'j@e.com', workUrl: null, note: 'hi' });
  assert.ok('error' in sanitizeClaimInput({ slug: '../x', contactEmail: 'j@e.com' }));
  assert.ok('error' in sanitizeClaimInput({ slug: 'a', contactEmail: 'nope' }));
  assert.ok('error' in sanitizeClaimInput({ slug: 'a', contactEmail: 'j@e.com', workUrl: 'ftp://x' }));
});
