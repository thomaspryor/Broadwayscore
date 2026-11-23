/**
 * BRO-8056 phase 2: /api/show-refresh/revalidate decides with planRevalidate
 * (src/lib/show-refresh-revalidate.ts). Off until the secret exists; wrong
 * secret refused; bad input refused; a good call lists page + reviews.json per
 * slug, '/' when asked, and the tag flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRevalidate, revalidateAuth, MAX_REVALIDATE_SLUGS } from '../../src/lib/show-refresh-revalidate';

const SECRET = 's'.repeat(40);
const call = (body: unknown, given: string | null = SECRET, configured: string | undefined = SECRET) =>
  planRevalidate({ configuredSecret: configured, givenSecret: given, body });

test('route does not exist until a long secret is configured', () => {
  assert.deepEqual(call({ tag: true }, SECRET, ''), { ok: false, status: 404, error: 'not found' });
  assert.equal((call({ tag: true }, 'short', 'short') as { status: number }).status, 404);
});

test('wrong or missing secret is refused', () => {
  assert.equal((call({ tag: true }, null) as { status: number }).status, 401);
  assert.equal((call({ tag: true }, 'x'.repeat(40)) as { status: number }).status, 401);
  assert.equal((call({ tag: true }, SECRET + 'x') as { status: number }).status, 401);
});

test('bad bodies are refused', () => {
  for (const body of [null, [], 'x', { slugs: 'a' }, { home: 'yes' }, { slugs: ['../etc'] }, { slugs: ['A'] }, { slugs: [1] }, {},
    { slugs: Array.from({ length: MAX_REVALIDATE_SLUGS + 1 }, (_, i) => `s${i}`) }]) {
    assert.equal((call(body) as { status: number }).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test('a good call lists both surfaces per slug, home, and the tag', () => {
  assert.deepEqual(call({ slugs: ['hamilton', 'hamilton', 'the-lost-boys-2026'], home: true }), {
    ok: true, tag: false,
    paths: ['/show/hamilton', '/show/hamilton/reviews.json', '/show/the-lost-boys-2026', '/show/the-lost-boys-2026/reviews.json', '/'],
  });
  assert.deepEqual(call({ tag: true }), { ok: true, tag: true, paths: [] });
});

test('only a slice hash counts as a refreshed render (ranks hidden, render-time lastUpdated)', async () => {
  const { isRefreshedRev } = await import('../../src/lib/show-refresh-core');
  assert.equal(isRefreshedRev('0123456789abcdef'), true);
  for (const rev of ['base', 'base-error', '', null, undefined, '0123456789ABCDEF', '0123456789abcde']) assert.equal(isRefreshedRev(rev), false, String(rev));
});

test('revalidateAuth runs alone (before the body is read) and agrees with planRevalidate', () => {
  const secret = 'x'.repeat(40);
  assert.equal(revalidateAuth(undefined, secret)?.status, 404);
  assert.equal(revalidateAuth(secret, null)?.status, 401);
  assert.equal(revalidateAuth(secret, secret.slice(1))?.status, 401);
  assert.equal(revalidateAuth(secret, secret + 'y')?.status, 401);
  assert.equal(revalidateAuth(secret, secret), null);
});
