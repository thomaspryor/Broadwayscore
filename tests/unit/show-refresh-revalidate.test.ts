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

// ---- BRO-8170 gap 2: the kill switch revalidates cached pages ------------------
/* eslint-disable @typescript-eslint/no-require-imports */
const cli = require('../../scripts/show-refresh-revalidate.js');
/* eslint-enable @typescript-eslint/no-require-imports */
const repo = path.join(__dirname, '../..');

function fakeSite(...answers: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => a.body };
  };
  return { fetchImpl, calls };
}
const quiet = { log: () => {}, sleep: async () => {} };

test('gap 2 script: posts all+tag with the secret; ok with paths is exit 0', async () => {
  const { fetchImpl, calls } = fakeSite({ status: 200, body: { ok: true, tag: true, count: 1665 } });
  const code = await cli.revalidateAll({ env: { SHOW_REFRESH_REVALIDATE_SECRET: SECRET }, fetchImpl, ...quiet });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://broadwayscorecard.com/api/show-refresh/revalidate');
  assert.equal((calls[0].init.headers as Record<string, string>)['x-show-refresh-secret'], SECRET);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { all: true, tag: true });
});

test('gap 2 script: exit 3 only when the secret is unset here; a 404 with the secret set fails', async () => {
  const site = fakeSite({ status: 200, body: { ok: true, count: 3 } });
  assert.equal(await cli.revalidateAll({ env: {}, ...site, ...quiet }), 3);
  assert.equal(site.calls.length, 0, 'no request without a secret');
  const s404 = fakeSite({ status: 404, body: { ok: false, error: 'not found' } });
  assert.equal(await cli.revalidateAll({ env: { SHOW_REFRESH_REVALIDATE_SECRET: SECRET }, ...s404, ...quiet }), 1);
  assert.equal(s404.calls.length, 1, '4xx is never retried');
});

test('gap 2 script: ok with 0 paths fails; no manifest is a warning; 5xx and network retry then fail', async () => {
  const env = { SHOW_REFRESH_REVALIDATE_SECRET: SECRET };
  assert.equal(await cli.revalidateAll({ env, ...fakeSite({ status: 200, body: { ok: true, count: 0 } }), ...quiet }), 1);
  assert.equal(await cli.revalidateAll({ env, ...fakeSite({ status: 503, body: { ok: false, error: 'no build manifest in this deployment' } }), ...quiet }), 0);
  assert.equal(await cli.revalidateAll({ env, ...fakeSite({ status: 401, body: { ok: false } }), ...quiet }), 1);
  const s5 = fakeSite({ status: 502, body: null }, { status: 200, body: { ok: true, count: 9 } });
  assert.equal(await cli.revalidateAll({ env, ...s5, ...quiet }), 0, '5xx retried once');
  const net = fakeSite(new Error('ECONNRESET'), new Error('ECONNRESET'));
  assert.equal(await cli.revalidateAll({ env, ...net, ...quiet }), 1);
  assert.equal(net.calls.length, 2);
});

test('gap 2 route: a 503 for all without a manifest uses the words the script treats as a warning', () => {
  const r = planRevalidate({ configuredSecret: SECRET, givenSecret: SECRET, body: { all: true }, refreshableSlugs: () => null });
  assert.equal(r.ok, false);
  const c = cli.classify((r as { status: number }).status, { ok: false, error: (r as { error: string }).error });
  assert.equal(c.code, 0);
  assert.equal(c.warning, true);
});

function stepBlock(yml: string, name: string): string {
  const i = yml.indexOf(`- name: ${name}`);
  assert.ok(i >= 0, `step "${name}" exists`);
  const rest = yml.slice(i + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next);
}

test('gap 2 workflow: kill/unkill run the revalidate script after Apply, with its secret; status does not', () => {
  const yml = fs.readFileSync(path.join(repo, '.github/workflows/show-refresh-kill.yml'), 'utf8');
  const step = stepBlock(yml, 'Revalidate cached show pages');
  assert.ok(yml.indexOf('- name: Apply') < yml.indexOf('- name: Revalidate cached show pages'), 'runs after the kill is applied');
  assert.ok(yml.indexOf('- name: Revalidate cached show pages') < yml.indexOf('- name: Notify on failure'), 'its failure notifies');
  assert.match(step, /if: inputs\.action != 'status'/);
  assert.match(step, /SHOW_REFRESH_REVALIDATE_SECRET: \$\{\{ secrets\.SHOW_REFRESH_REVALIDATE_SECRET \}\}/);
  assert.match(step, /node scripts\/show-refresh-revalidate\.js/);
  assert.match(step, /set -o pipefail/, 'tee must not hide the exit code');
  assert.match(step, /"\$rc" = 3/);
  assert.match(step, /exit "\$rc"/, 'any other failure fails the job');
  assert.doesNotMatch(stepBlock(yml, 'Apply'), /show-refresh-revalidate/, 'kept out of the kill step itself');
});

// ---- BRO-8170 gap 4: the health check can read published slices ---------------
test('gap 4 workflow: the health check step passes the Supabase URL and anon key prod-data-parity needs', () => {
  const yml = fs.readFileSync(path.join(repo, '.github/workflows/data-health-check.yml'), 'utf8');
  const step = stepBlock(yml, 'Run health check');
  assert.match(step, /run: node scripts\/health-check\.js/);
  /* eslint-disable @typescript-eslint/no-require-imports */
  const store = require('../../scripts/lib/show-refresh/store');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const env: Record<string, string> = {};
  for (const m of step.matchAll(/^\s+([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}/gm)) env[m[1]] = `secret:${m[2]}`;
  // The reader store prod-data-parity builds must construct from exactly this env.
  assert.doesNotThrow(() => store.readerStoreFromEnv(env), 'readerStoreFromEnv needs a Supabase URL and the anon key');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'secret:NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon key only, never the service role');
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
});
