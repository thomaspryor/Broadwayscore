/** BRO-7087: invite tokens and invite acceptance. Real functions, mocked I/O, no real email. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInvite, verifyInvite, inviteUrl, firstName, INVITE_TTL_SECONDS } from '../../src/lib/critic-invite';
import { acceptInvite, grantOwnership, type AcceptDeps, type RecordResult } from '../../src/lib/critic-ownership';

const SECRET = 'test-secret-not-real';
const NOW = Date.UTC(2026, 10, 7, 12);

test('sign/verify roundtrip returns the slug', () => {
  const t = signInvite(SECRET, 'jesse-green', NOW);
  const v = verifyInvite(SECRET, t, NOW + 1000);
  assert.deepEqual(v, { ok: true, slug: 'jesse-green', expiresAt: (Math.floor(NOW / 1000) + INVITE_TTL_SECONDS) * 1000 });
  assert.match(t, /^jesse-green\.\d+\.[0-9a-f]{64}$/);
});

test('expires after 14 days', () => {
  const t = signInvite(SECRET, 'jesse-green', NOW);
  assert.equal(verifyInvite(SECRET, t, NOW + 13.9 * 86_400_000).ok, true);
  assert.deepEqual(verifyInvite(SECRET, t, NOW + 14 * 86_400_000 + 1000), { ok: false, reason: 'expired' });
});

test('a token edited to another slug or a later expiry fails', () => {
  const t = signInvite(SECRET, 'jesse-green', NOW);
  const [, e, s] = t.split('.');
  assert.deepEqual(verifyInvite(SECRET, `ben-brantley.${e}.${s}`, NOW), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(verifyInvite(SECRET, `jesse-green.${Number(e) + 86_400}.${s}`, NOW), { ok: false, reason: 'bad-signature' });
});

test('wrong or missing secret fails', () => {
  const t = signInvite(SECRET, 'jesse-green', NOW);
  assert.deepEqual(verifyInvite('other-secret', t, NOW), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(verifyInvite(undefined, t, NOW), { ok: false, reason: 'no-secret' });
  assert.deepEqual(verifyInvite('', t, NOW), { ok: false, reason: 'no-secret' });
  assert.throws(() => signInvite('', 'jesse-green', NOW));
});

test('bad charset and malformed tokens are refused', () => {
  const t = signInvite(SECRET, 'jesse-green', NOW);
  const [, e, s] = t.split('.');
  for (const bad of [`Jesse-Green.${e}.${s}`, `jesse_green.${e}.${s}`, `../x.${e}.${s}`, `-x.${e}.${s}`, `jesse-green.${e}`, `jesse-green.${e}.${s}.x`, `jesse-green.1e9.${s}`, `jesse-green.${e}.${s.slice(1)}`, `jesse-green.${e}.${'z'.repeat(64)}`, '', null, 42, 'x'.repeat(201)]) {
    assert.deepEqual(verifyInvite(SECRET, bad, NOW), { ok: false, reason: 'malformed' }, String(bad));
  }
  assert.throws(() => signInvite(SECRET, 'Bad Slug', NOW));
});

test('inviteUrl and firstName', () => {
  assert.equal(inviteUrl('https://broadwayscorecard.com/', 'jesse-green', 'jesse-green.1.ab'), 'https://broadwayscorecard.com/critics/jesse-green?invite=jesse-green.1.ab');
  assert.equal(firstName('  Jesse   Green '), 'Jesse');
  assert.equal(firstName('Cher'), 'Cher');
});

// ---- grantOwnership (shared with the email Approve link) ----

test('grantOwnership upserts the profile and refreshes the page caches', async () => {
  const calls: { path: string; init?: RequestInit & { prefer?: string } }[] = [];
  const tags: string[] = []; const paths: string[] = [];
  const ok = await grantOwnership('jesse-green', 'u1', {
    sbAdmin: async (path, init) => { calls.push({ path, init }); return new Response(null, { status: 201 }); },
    revalidateTag: (t) => tags.push(t), revalidatePath: (p) => paths.push(p), now: () => new Date(NOW),
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/v1/critic_profiles?on_conflict=critic_slug');
  assert.equal(calls[0].init?.prefer, 'resolution=merge-duplicates,return=minimal');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { critic_slug: 'jesse-green', user_id: 'u1', verified_at: new Date(NOW).toISOString() });
  assert.deepEqual(tags, ['critic-profile:jesse-green', 'critic-profiles']);
  assert.deepEqual(paths, ['/critics/jesse-green', '/critics']);
});

test('grantOwnership returns false and refreshes nothing when the upsert fails', async () => {
  const tags: string[] = [];
  const ok = await grantOwnership('jesse-green', 'u1', {
    sbAdmin: async () => new Response('x', { status: 500 }), revalidateTag: (t) => tags.push(t), revalidatePath: (t) => tags.push(t),
  });
  assert.equal(ok, false);
  assert.deepEqual(tags, []);
});

// ---- acceptInvite ----

function deps(opts: { owner?: string | null | 'error'; ownerAfter?: string | null; record?: RecordResult; grantOk?: boolean } = {}) {
  const recorded: string[] = []; const granted: string[] = []; const emails: { subject: string; html: string }[] = [];
  let ownerCalls = 0;
  const d: AcceptDeps = {
    secret: SECRET, now: NOW, user: { id: 'u1', email: 'jesse@example.com' },
    criticName: (slug) => (slug === 'jesse-green' ? 'Jesse <Green>' : null),
    currentOwner: async () => (ownerCalls++ === 0 ? (opts.owner ?? null) : (opts.ownerAfter ?? null)),
    recordApproval: async (slug, userId, email) => { recorded.push(`${slug}:${userId}:${email}`); return opts.record ?? 'ok'; },
    grant: async (slug, userId) => { granted.push(`${slug}:${userId}`); return opts.grantOk ?? true; },
    emailOwner: async (subject, html) => { emails.push({ subject, html }); return true; },
    escHtml: (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)),
    site: 'https://broadwayscorecard.com',
  };
  return { d, recorded, granted, emails };
}
const token = () => signInvite(SECRET, 'jesse-green', NOW);

test('a fresh invite makes this account the owner and sends the owner one escaped FYI', async () => {
  const { d, recorded, granted, emails } = deps();
  const r = await acceptInvite({ slug: 'jesse-green', token: token() }, d);
  assert.deepEqual(r, { status: 200, body: { ok: true, state: 'owner' } });
  assert.deepEqual(recorded, ['jesse-green:u1:jesse@example.com']);
  assert.deepEqual(granted, ['jesse-green:u1']);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /accepted your invite/);
  assert.match(emails[0].html, /Jesse &lt;Green&gt; accepted your invite and now owns their page/);
  assert.ok(!emails[0].html.includes('<Green>'));
});

test('the same owner opening the link again is fine and sends no second email', async () => {
  const { d, recorded, granted, emails } = deps({ owner: 'u1' });
  const r = await acceptInvite({ slug: 'jesse-green', token: token() }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(recorded, []);
  assert.deepEqual(granted, ['jesse-green:u1']); // repairs a half-done profile row
  assert.equal(emails.length, 0);
});

test('a page owned by someone else is refused with a plain message', async () => {
  const { d, recorded, granted, emails } = deps({ owner: 'someone-else' });
  const r = await acceptInvite({ slug: 'jesse-green', token: token() }, d);
  assert.deepEqual(r, { status: 409, body: { error: 'This page already has an owner.' } });
  assert.equal(recorded.length + granted.length + emails.length, 0);
});

test('losing a race to another account is refused; losing it to yourself is fine', async () => {
  const lost = deps({ record: 'conflict', ownerAfter: 'someone-else' });
  assert.equal((await acceptInvite({ slug: 'jesse-green', token: token() }, lost.d)).status, 409);
  assert.equal(lost.granted.length + lost.emails.length, 0);
  const self = deps({ record: 'conflict', ownerAfter: 'u1' });
  assert.equal((await acceptInvite({ slug: 'jesse-green', token: token() }, self.d)).status, 200);
  assert.equal(self.emails.length, 0);
});

test('bad, expired, or mismatched tokens change nothing', async () => {
  const cases: [unknown, number][] = [
    [{ slug: 'ben-brantley', token: token() }, 400],
    [{ slug: 'jesse-green', token: 'jesse-green.1.' + 'a'.repeat(64) }, 410],
    [{ slug: 'jesse-green', token: signInvite('other', 'jesse-green', NOW) }, 400],
    [{ slug: 'jesse-green' }, 400],
    [null, 400],
  ];
  for (const [body, status] of cases) {
    const { d, recorded, granted, emails } = deps();
    assert.equal((await acceptInvite(body, d)).status, status, JSON.stringify(body));
    assert.equal(recorded.length + granted.length + emails.length, 0);
  }
  const unknown = deps();
  assert.equal((await acceptInvite({ slug: 'nobody-here', token: signInvite(SECRET, 'nobody-here', NOW) }, unknown.d)).status, 404);
});

test('storage failures return an error and send no email', async () => {
  for (const o of [{ owner: 'error' as const }, { record: 'error' as const }, { grantOk: false }]) {
    const { d, emails } = deps(o);
    assert.equal((await acceptInvite({ slug: 'jesse-green', token: token() }, d)).status, 502, JSON.stringify(o));
    assert.equal(emails.length, 0);
  }
});
