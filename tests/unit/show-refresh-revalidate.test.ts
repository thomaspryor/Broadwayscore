/**
 * BRO-8056 phase 2: /api/show-refresh/revalidate decides with planRevalidate
 * (src/lib/show-refresh-revalidate.ts). Off until the secret exists; wrong
 * secret refused; bad input refused; a good call lists page + reviews.json per
 * slug, '/' when asked, and the tag flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { planRevalidate, revalidateAuth, showSurfacePaths, MAX_REVALIDATE_SLUGS } from '../../src/lib/show-refresh-revalidate';

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

test('a good call lists every surface per slug (page, reviews.json, OG image), home, the tag, and always the pointer tag', () => {
  assert.deepEqual(call({ slugs: ['hamilton', 'hamilton', 'the-lost-boys-2026'], home: true }), {
    ok: true, tag: false, pointerTag: true,
    paths: [
      '/show/hamilton', '/show/hamilton/reviews.json', '/show/hamilton/opengraph-image',
      '/show/the-lost-boys-2026', '/show/the-lost-boys-2026/reviews.json', '/show/the-lost-boys-2026/opengraph-image', '/',
    ],
  });
  assert.deepEqual(call({ tag: true }), { ok: true, tag: true, pointerTag: true, paths: [] });
});

// Gap 6 class guard: every cached route under src/app/show/[slug]/ that renders
// this show's data (getShowForRender) must be in showSurfacePaths, or a publish
// or kill leaves it serving the old data until its own ISR expiry.
test('gap 6: showSurfacePaths covers every route under show/[slug] that reads getShowForRender', () => {
  const dir = path.join(__dirname, '../../src/app/show/[slug]');
  const routes: string[] = [];
  (function walk(d: string, rel: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, `${rel}/${e.name}`); continue; }
      const m = e.name.match(/^(page|route|opengraph-image|twitter-image|icon)\.tsx?$/);
      if (!m || !/getShowForRender/.test(fs.readFileSync(p, 'utf8'))) continue;
      routes.push(m[1] === 'page' || m[1] === 'route' ? (rel || '/') : `${rel}/${m[1]}`);
    }
  })(dir, '');
  assert.ok(routes.length >= 3, `found ${routes.join(', ')}`);
  const listed = showSurfacePaths('x').map(p => p.slice('/show/x'.length) || '/');
  for (const r of routes) assert.ok(listed.includes(r), `show/[slug]${r} reads getShowForRender but is not revalidated`);
});

test('all: expands to the refreshable slugs of this deployment, merged with explicit slugs', () => {
  const plan = planRevalidate({ configuredSecret: SECRET, givenSecret: SECRET, body: { all: true, tag: true, slugs: ['wicked'] }, refreshableSlugs: () => ['hamilton', 'wicked', 'Bad Slug'] });
  assert.deepEqual(plan, { ok: true, tag: true, pointerTag: true, paths: [...showSurfacePaths('wicked'), ...showSurfacePaths('hamilton')] });
  const none = planRevalidate({ configuredSecret: SECRET, givenSecret: SECRET, body: { all: true, tag: true }, refreshableSlugs: () => null });
  assert.deepEqual(none, { ok: false, status: 503, error: 'no build manifest in this deployment' });
  assert.equal((call({ all: 'yes' }) as { status: number }).status, 400);
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
