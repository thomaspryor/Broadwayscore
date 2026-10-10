// src/middleware.ts wiring (2026 data audit, S5-T9 + S7-T3 follow-up): the
// edge middleware delegates to src/lib/slug-redirects.ts resolvePathRedirect()
// and covers /show/*, /critics/* and the name-derived families (/creative,
// /theater, /west-end/theater, /off-broadway/theater, /cast). Runs the REAL
// middleware against the real tracked data/slug-redirects-compact.json
// through the same next/server subpath loader tests/unit/api-feedback.test.mjs
// uses. Registered in tests/unit-test-manifest-tsx.txt because it imports
// TypeScript.
//
// The /critics/* and name-family cases only have data to run against once
// prebuild regenerates the compact map (critics: from the core-data registry
// data/critic-slug-aliases.json; name families: derived from shows.json + the
// cast manifest); until then they self-skip and the branches are covered by
// the pure cases in tests/unit/slug-redirects.test.ts and the real-data
// lookups in tests/unit/name-slug-redirects.test.ts.
//
// Run: npx tsx --test tests/unit/middleware-slug-redirects.test.mjs
import { register } from 'node:module';
register('../../src/app/api/__tests__/next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compact = require('../../data/slug-redirects-compact.json');
const { CRITIC_REDIRECT_PREFIX } = require('../../scripts/lib/critic-slug-aliases.js');
const { NAME_REDIRECT_PREFIXES } = require('../../scripts/lib/name-slug-redirects.js');

const ORIGIN = 'https://broadwayscorecard.com';

async function run(pathname) {
  const { middleware } = await import('../../src/middleware.ts');
  const { NextRequest } = await import('next/server');
  return middleware(new NextRequest(`${ORIGIN}${pathname}`));
}

function locationPath(res) {
  return new URL(res.headers.get('location')).pathname;
}

async function routeOf(family) {
  const { NAME_ROUTE_FAMILIES } = await import('../../src/lib/slug-redirects.ts');
  return NAME_ROUTE_FAMILIES.find((f) => f.family === family).route;
}

test('matcher covers /show/*, /critics/* and every name-derived route family, in the resolver\'s own terms', async () => {
  const { config } = await import('../../src/middleware.ts');
  const { NAME_ROUTE_FAMILIES } = await import('../../src/lib/slug-redirects.ts');
  assert.deepEqual(config.matcher, ['/show/:slug+', '/critics/:slug+', ...NAME_ROUTE_FAMILIES.map((f) => `${f.route}:slug+`)]);
  assert.deepEqual(config.matcher, [
    '/show/:slug+',
    '/critics/:slug+',
    '/creative/:slug+',
    '/theater/:slug+',
    '/west-end/theater/:slug+',
    '/off-broadway/theater/:slug+',
    '/cast/:slug+',
  ]);
});

test('/show/<redirect key> redirects with the status the map encodes', async () => {
  const permanent = Object.entries(compact).find(([k, v]) => !k.includes(':') && !v.startsWith('~'));
  assert.ok(permanent, 'compact map has at least one permanent show redirect');
  const res = await run(`/show/${permanent[0]}`);
  assert.equal(res?.status, 301, `/show/${permanent[0]}`);
  assert.equal(locationPath(res), `/show/${permanent[1]}`);

  const temporary = Object.entries(compact).find(([k, v]) => !k.includes(':') && v.startsWith('~'));
  if (temporary) {
    const t = await run(`/show/${temporary[0]}`);
    assert.equal(t?.status, 302, `/show/${temporary[0]}`);
    assert.equal(locationPath(t), `/show/${temporary[1].slice(1)}`);
  }
});

test('unknown, nested and index paths fall through to the page', async () => {
  for (const p of [
    '/show/this-show-does-not-exist-xyz-123',
    '/critics/outlets',
    '/critics/outlets/nytimes',
    '/critics/this-critic-does-not-exist-xyz-123',
    '/creative/this-person-does-not-exist-xyz-123',
    '/creative/this-person-does-not-exist-xyz-123/shows',
    '/theater/this-theater-does-not-exist-xyz-123',
    '/west-end/theater/this-venue-does-not-exist-xyz-123',
    '/west-end/theater/this-venue-does-not-exist-xyz-123/nested',
    '/off-broadway/theater/this-venue-does-not-exist-xyz-123',
    '/cast/this-actor-does-not-exist-xyz-123',
    '/theater/',
    '/west-end/theater',
    '/west-end/theater/',
    '/cast/',
  ]) {
    assert.equal(await run(p), undefined, p);
  }
});

for (const [family, prefix] of Object.entries(NAME_REDIRECT_PREFIXES)) {
  const keys = Object.keys(compact).filter((k) => k.startsWith(prefix));
  test(
    `${prefix} retired slugs 301 to the live page on their own route (${keys.length} entries)`,
    { skip: keys.length === 0 ? `no ${prefix} entries in the tracked compact map yet (prebuild regenerates it)` : false },
    async () => {
      const route = await routeOf(family);
      for (const key of keys) {
        const oldSlug = key.slice(prefix.length);
        const res = await run(`${route}${oldSlug}`);
        assert.equal(res?.status, 301, `${route}${oldSlug}`);
        assert.equal(locationPath(res), `${route}${compact[key]}`);
        assert.equal(await run(`${route}${oldSlug}/nested`), undefined, 'nested paths fall through');
      }
    }
  );
}

const anyNameKey = Object.entries(NAME_REDIRECT_PREFIXES)
  .map(([family, prefix]) => ({ family, prefix, key: Object.keys(compact).find((k) => k.startsWith(prefix)) }))
  .find((x) => x.key);
test(
  'a retired slug is not reachable through another family\'s route',
  { skip: anyNameKey ? false : 'no name-family entries in the tracked compact map yet (prebuild regenerates it)' },
  async () => {
    const oldSlug = anyNameKey.key.slice(anyNameKey.prefix.length);
    for (const family of Object.keys(NAME_REDIRECT_PREFIXES)) {
      if (family === anyNameKey.family) continue;
      const route = await routeOf(family);
      if (compact[NAME_REDIRECT_PREFIXES[family] + oldSlug]) continue; // the same old slug happens to be retired there too
      assert.equal(await run(`${route}${oldSlug}`), undefined, `${route}${oldSlug}`);
    }
    if (!compact[oldSlug]) assert.equal(await run(`/show/${oldSlug}`), undefined, `/show/${oldSlug}`);
  }
);

const criticKeys = Object.keys(compact).filter((k) => k.startsWith(CRITIC_REDIRECT_PREFIX));
test(
  '/critics/<retired slug> 301s to the canonical critic page',
  { skip: criticKeys.length === 0 ? 'no critic aliases in the compact map yet (registry absent when prebuild last ran)' : false },
  async () => {
    for (const key of criticKeys) {
      const oldSlug = key.slice(CRITIC_REDIRECT_PREFIX.length);
      const res = await run(`/critics/${oldSlug}`);
      assert.equal(res?.status, 301, `/critics/${oldSlug}`);
      assert.equal(locationPath(res), `/critics/${compact[key]}`);
    }
  }
);
