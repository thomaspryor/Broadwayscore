/**
 * BRO-6895: signed approve/decline links and the "critics can never change
 * scores" guard. Requires the real helpers (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signClaimLink, verifyClaimLink, sanitizeProfileEdit, sanitizeClaimInput, sanitizeFlagInput, selectNoticeReviews, cleanSocialLink, claimHints, claimLimitVerdict, ownerEmailPlan, rateLimitAllow, claimsDisabled, countUrls, CLAIM_LINK_TTL_SECONDS } from '../../src/lib/critic-claim';

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
  const soc = [{ platform: 'instagram', value: '@jordan' }];
  assert.deepEqual(sanitizeClaimInput({ slug: 'jordan-ellis', contactEmail: 'j@e.com', socials: soc, workUrl: '', note: ' hi ' }), { slug: 'jordan-ellis', contactEmail: 'j@e.com', socials: [{ platform: 'instagram', url: 'https://instagram.com/jordan' }], workUrl: null, note: 'hi' });
  assert.ok('error' in sanitizeClaimInput({ slug: '../x', contactEmail: 'j@e.com' }));
  assert.ok('error' in sanitizeClaimInput({ slug: 'a', contactEmail: 'nope' }));
  assert.ok('error' in sanitizeClaimInput({ slug: 'a', contactEmail: 'j@e.com', socials: soc, workUrl: 'ftp://x' }));
});

test('a score flag must name one of the critic\'s own reviews and carries only text', () => {
  const own = new Set(['hamilton-abc', 'wicked-def']);
  const ok = sanitizeFlagInput({ slug: 'jordan-ellis', reviewKey: 'wicked-def', note: ' score looks low ', reviewScore: 100, score: 100 }, own);
  assert.deepEqual(ok, { slug: 'jordan-ellis', reviewKey: 'wicked-def', note: 'score looks low' });
  assert.ok(!('reviewScore' in ok) && !('score' in ok));
  assert.ok('error' in sanitizeFlagInput({ slug: 'jordan-ellis', reviewKey: 'someone-elses', note: 'x' }, own));
  assert.ok('error' in sanitizeFlagInput({ slug: 'jordan-ellis', reviewKey: 'wicked-def', note: '   ' }, own));
  assert.ok('error' in sanitizeFlagInput({ slug: '../x', reviewKey: 'wicked-def', note: 'x' }, own));
});

test('opening-night notice picks recent, unsent reviews once per show', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const day = 86_400_000;
  const reviews = [
    { showSlug: 'a', showTitle: 'A', parsedDate: now - 1 * day },
    { showSlug: 'a', showTitle: 'A', parsedDate: now - 2 * day },
    { showSlug: 'b', showTitle: 'B', parsedDate: now - 10 * day },
    { showSlug: 'c', showTitle: 'C', parsedDate: now - 1 * day },
    { showSlug: 'd', showTitle: 'D', parsedDate: now + 5 * day },
    { showSlug: 'e', showTitle: 'E', parsedDate: null },
  ];
  const out = selectNoticeReviews(reviews, new Set(['c']), now, 3);
  assert.deepEqual(out.map((r) => r.showSlug), ['a']);
  assert.equal(out[0].parsedDate, now - 1 * day);
});

test('social links: URL on the platform host or an @handle; anything else is refused', () => {
  assert.deepEqual(cleanSocialLink('instagram', '@jane'), { platform: 'instagram', url: 'https://instagram.com/jane' });
  assert.deepEqual(cleanSocialLink('bluesky', 'jane'), { platform: 'bluesky', url: 'https://bsky.app/profile/jane.bsky.social' });
  assert.equal(cleanSocialLink('x', 'https://twitter.com/jane')?.url, 'https://twitter.com/jane');
  assert.equal(cleanSocialLink('instagram', 'https://x.com/jane'), null);
  assert.equal(cleanSocialLink('instagram', 'https://instagram.com/'), null);
  assert.equal(cleanSocialLink('instagram', 'https://instagram.com.evil.example/jane'), null);
  assert.equal(cleanSocialLink('instagram', 'javascript:alert(1)'), null);
  assert.equal(cleanSocialLink('myspace', '@jane'), null);
  assert.equal(cleanSocialLink('x', '@bad handle'), null);
});

test('claim form needs one to three social accounts, other fields optional', () => {
  const base = { slug: 'jane-doe', contactEmail: 'jane@nytimes.com' };
  assert.ok('error' in sanitizeClaimInput({ ...base, socials: [] }));
  assert.ok('error' in sanitizeClaimInput({ ...base }));
  assert.ok('error' in sanitizeClaimInput({ ...base, socials: [{ platform: 'x', value: 'https://evil.example/x' }] }));
  const ok = sanitizeClaimInput({ ...base, socials: [{ platform: 'x', value: '@jane' }, { platform: 'x', value: '@jane' }, { platform: 'instagram', value: 'jane' }, { platform: 'tiktok', value: 'fourth-is-ignored' }] });
  assert.ok(!('error' in ok));
  if (!('error' in ok)) { assert.equal(ok.socials.length, 2); assert.equal(ok.workUrl, null); assert.equal(ok.note, null); }
});

test('claim hints are information only and cover the four cases', () => {
  const h = (o: Partial<Parameters<typeof claimHints>[0]>) => claimHints({ contactEmail: 'a@nytimes.com', accountEmail: 'a@nytimes.com', outletDomain: 'nytimes.com', otherClaimStatuses: [], ...o });
  assert.deepEqual(h({}), ['Email domain matches their outlet (nytimes.com)']);
  assert.deepEqual(h({ contactEmail: 'a@gmail.com', accountEmail: 'a@gmail.com' }), ['Personal email (gmail etc.)']);
  assert.ok(h({ accountEmail: 'b@gmail.com' }).includes('Signed-in account email differs from contact email'));
  assert.ok(h({ otherClaimStatuses: ['pending'] }).includes('Another claim on this page is pending'));
  assert.ok(h({ otherClaimStatuses: ['pending', 'approved'] }).includes('Another claim on this page is approved'));
  assert.ok(!h({ contactEmail: 'a@notnytimes.com', accountEmail: 'a@notnytimes.com' }).some((x) => x.startsWith('Email domain matches')));
});

test('claim limits: one pending per account, three per day, notes with many links rejected', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  assert.deepEqual(claimLimitVerdict([], 'a', now), { ok: true });
  const pendingElsewhere = claimLimitVerdict([{ status: 'pending', critic_slug: 'b', created_at: ago(1) }], 'a', now);
  assert.ok(!pendingElsewhere.ok && pendingElsewhere.reason === 'pending-elsewhere');
  // Pending on the same page is handled as "already requested" by the route, not by this rule.
  assert.deepEqual(claimLimitVerdict([{ status: 'pending', critic_slug: 'a', created_at: ago(1) }], 'a', now), { ok: true });
  const three = ['x', 'y', 'z'].map((s, i) => ({ status: 'declined', critic_slug: s, created_at: ago(2 + i) }));
  const capped = claimLimitVerdict(three, 'a', now);
  assert.ok(!capped.ok && capped.reason === 'daily-cap');
  assert.deepEqual(claimLimitVerdict(three.map((c) => ({ ...c, created_at: ago(30) })), 'a', now), { ok: true });
  const base = { slug: 'jane-doe', contactEmail: 'j@e.com', socials: [{ platform: 'x', value: '@jane' }] };
  assert.ok('error' in sanitizeClaimInput({ ...base, note: 'see https://a.example https://b.example www.c.example' }));
  assert.ok(!('error' in sanitizeClaimInput({ ...base, note: 'see https://a.example and www.b.example' })));
  assert.equal(countUrls('none here'), 0);
});

test('owner email: one full email per pending page, then at most one note a day', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  assert.equal(ownerEmailPlan([], now), 'full');
  assert.equal(ownerEmailPlan([{ status: 'approved', owner_emailed_at: ago(1) }], now), 'full');
  assert.equal(ownerEmailPlan([{ status: 'pending', owner_emailed_at: ago(1) }], now), 'none');
  assert.equal(ownerEmailPlan([{ status: 'pending', owner_emailed_at: ago(30) }], now), 'note');
  assert.equal(ownerEmailPlan([{ status: 'pending', owner_emailed_at: null }], now), 'note');
});

test('rate limiter and kill switch', () => {
  const m = new Map<string, { n: number; t: number }>();
  assert.deepEqual([1, 2, 3, 4].map(() => rateLimitAllow(m, 'ip', 3, 1000, 0)), [true, true, true, false]);
  assert.equal(rateLimitAllow(m, 'ip', 3, 1000, 2000), true);
  assert.equal(claimsDisabled({ CRITIC_CLAIMS_DISABLED: 'true' }), true);
  assert.equal(claimsDisabled({ CRITIC_CLAIMS_DISABLED: 'TRUE ' }), true);
  assert.equal(claimsDisabled({}), false);
  assert.equal(claimsDisabled({ CRITIC_CLAIMS_DISABLED: 'false' }), false);
});

test('critic page JSON-LD escapes < so a bio cannot close the script tag', () => {
  const src = require('node:fs').readFileSync('src/app/critics/[slug]/page.tsx', 'utf8');
  assert.ok(/JSON\.stringify\(\[breadcrumbSchema, criticSchema, faqSchema\]\)\.replace\(\/<\/g/.test(src));
});
