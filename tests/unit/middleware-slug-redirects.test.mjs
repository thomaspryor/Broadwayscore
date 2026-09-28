// src/middleware.ts wiring (2026 data audit, S5-T9): the edge middleware
// delegates to src/lib/slug-redirects.ts resolvePathRedirect() and now covers
// /critics/* as well as /show/*. Runs the REAL middleware against the real
// tracked data/slug-redirects-compact.json through the same next/server
// subpath loader tests/unit/api-feedback.test.mjs uses. Registered in
// tests/unit-test-manifest-tsx.txt because it imports TypeScript.
//
// The /critics/* case only has data to run against once the core-data
// registry (data/critic-slug-aliases.json) exists when prebuild regenerates
// the compact map; until then it self-skips and the branch is covered by the
// pure cases in tests/unit/slug-redirects.test.ts.
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

const ORIGIN = 'https://broadwayscorecard.com';

async function run(pathname) {
  const { middleware } = await import('../../src/middleware.ts');
  const { NextRequest } = await import('next/server');
  return middleware(new NextRequest(`${ORIGIN}${pathname}`));
}

function locationPath(res) {
  return new URL(res.headers.get('location')).pathname;
}

test('matcher covers /show/* and /critics/*', async () => {
  const { config } = await import('../../src/middleware.ts');
  assert.deepEqual(config.matcher, ['/show/:slug+', '/critics/:slug+']);
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
  ]) {
    assert.equal(await run(p), undefined, p);
  }
});

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
