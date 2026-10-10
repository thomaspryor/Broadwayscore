/**
 * src/lib/slug-redirects.ts — pure redirect resolution over the compact map
 * (2026 data audit, S5-T9), plus the data-reviews.ts wiring that reads it
 * (getCriticBySlug() alias fallback, asserted here on the real tracked map).
 * The middleware wiring is asserted by tests/unit/middleware-slug-redirects.test.mjs.
 *
 * Run: npx tsx --test tests/unit/slug-redirects.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  CRITIC_REDIRECT_PREFIX,
  NAME_REDIRECT_PREFIXES,
  NAME_ROUTE_FAMILIES,
  resolveShowRedirect,
  resolveCriticRedirect,
  resolveNameRedirect,
  resolvePathRedirect,
} from '../../src/lib/slug-redirects';
import { getCriticBySlug, getAllCriticSlugs } from '../../src/lib/data-reviews';

const require = createRequire(import.meta.url);
const emitter = require('../../scripts/lib/critic-slug-aliases.js') as { CRITIC_REDIRECT_PREFIX: string };
const nameEmitter = require('../../scripts/lib/name-slug-redirects.js') as { NAME_REDIRECT_PREFIXES: Record<string, string> };
const compact = require('../../data/slug-redirects-compact.json') as Record<string, string>;

const MAP: Record<string, string> = {
  hamilton: 'hamilton-2015',
  cabaret: '~cabaret-2024',
  'hamilton-west-end-2017': 'hamilton-west-end',
  'critic:jose-sol-s': 'jose-solis',
  // Name-derived families (S7-T3 follow-up): pre-fold slug → live slug.
  'creative:no-l-coward': 'noel-coward-2',
  'theater:caf-broadway-theatre': 'cafe-broadway-theatre',
  'west-end-theater:no-l-coward-theatre': 'noel-coward-theatre',
  'off-broadway-theater:repertorio-espa-ol-spanish-theatre-repertory': 'repertorio-espanol-spanish-theatre-repertory',
  'cast:ren-ceballos': 'rene-ceballos-2',
};

describe('prefix parity', () => {
  test('the TS resolver and the JS emitter agree on the critic key prefix', () => {
    assert.equal(CRITIC_REDIRECT_PREFIX, emitter.CRITIC_REDIRECT_PREFIX);
  });

  test('the TS resolver and the JS emitter agree on every name-family key prefix', () => {
    assert.deepEqual({ ...NAME_REDIRECT_PREFIXES }, nameEmitter.NAME_REDIRECT_PREFIXES);
  });

  test('every family has exactly one route, routes are distinct single-segment prefixes, and none is /show or /critics', () => {
    assert.deepEqual(NAME_ROUTE_FAMILIES.map((f) => f.family).sort(), Object.keys(NAME_REDIRECT_PREFIXES).sort());
    const routes = NAME_ROUTE_FAMILIES.map((f) => f.route);
    assert.equal(new Set(routes).size, routes.length);
    for (const r of routes) {
      assert.match(r, /^\/[a-z-]+(\/[a-z-]+)?\/$/, r);
      assert.ok(!r.startsWith('/show/') && !r.startsWith('/critics/'), r);
    }
  });
});

describe('resolveShowRedirect', () => {
  test('permanent entry', () => {
    assert.deepEqual(resolveShowRedirect(MAP, 'hamilton'), { target: 'hamilton-2015', permanent: true });
  });

  test('"~" entry is temporary (multi-production versionless slug)', () => {
    assert.deepEqual(resolveShowRedirect(MAP, 'cabaret'), { target: 'cabaret-2024', permanent: false });
  });

  test('lookup is case-insensitive', () => {
    assert.equal(resolveShowRedirect(MAP, 'Hamilton-West-End-2017')?.target, 'hamilton-west-end');
  });

  test('unknown slug, empty slug and a namespaced key are misses', () => {
    assert.equal(resolveShowRedirect(MAP, 'nope'), null);
    assert.equal(resolveShowRedirect(MAP, ''), null);
    assert.equal(resolveShowRedirect(MAP, 'critic:jose-sol-s'), null);
  });
});

describe('resolveCriticRedirect', () => {
  test('retired slug resolves to the canonical slug', () => {
    assert.equal(resolveCriticRedirect(MAP, 'jose-sol-s'), 'jose-solis');
  });

  test('lookup is case-insensitive', () => {
    assert.equal(resolveCriticRedirect(MAP, 'Jose-Sol-S'), 'jose-solis');
  });

  test('a show key is not reachable through the critic namespace; unknown/empty are misses', () => {
    assert.equal(resolveCriticRedirect(MAP, 'hamilton'), null);
    assert.equal(resolveCriticRedirect(MAP, 'unknown-person'), null);
    assert.equal(resolveCriticRedirect(MAP, ''), null);
  });
});

describe('resolveNameRedirect', () => {
  test('retired slug resolves to the live slug within its own family', () => {
    assert.equal(resolveNameRedirect(MAP, 'creative', 'no-l-coward'), 'noel-coward-2');
    assert.equal(resolveNameRedirect(MAP, 'theater', 'caf-broadway-theatre'), 'cafe-broadway-theatre');
    assert.equal(resolveNameRedirect(MAP, 'westEndTheater', 'no-l-coward-theatre'), 'noel-coward-theatre');
    assert.equal(resolveNameRedirect(MAP, 'offBroadwayTheater', 'repertorio-espa-ol-spanish-theatre-repertory'), 'repertorio-espanol-spanish-theatre-repertory');
    assert.equal(resolveNameRedirect(MAP, 'cast', 'ren-ceballos'), 'rene-ceballos-2');
  });

  test('lookup is case-insensitive', () => {
    assert.equal(resolveNameRedirect(MAP, 'creative', 'No-L-Coward'), 'noel-coward-2');
  });

  test('families never see each other\'s keys, nor the show/critic namespaces; unknown/empty are misses', () => {
    assert.equal(resolveNameRedirect(MAP, 'westEndTheater', 'caf-broadway-theatre'), null, '/theater key not reachable from /west-end/theater');
    assert.equal(resolveNameRedirect(MAP, 'theater', 'no-l-coward-theatre'), null, '/west-end/theater key not reachable from /theater');
    assert.equal(resolveNameRedirect(MAP, 'cast', 'no-l-coward'), null);
    assert.equal(resolveNameRedirect(MAP, 'creative', 'hamilton'), null);
    assert.equal(resolveNameRedirect(MAP, 'creative', 'jose-sol-s'), null);
    assert.equal(resolveNameRedirect(MAP, 'creative', 'unknown-person'), null);
    assert.equal(resolveNameRedirect(MAP, 'creative', ''), null);
  });
});

describe('resolvePathRedirect', () => {
  test('/show/<slug> → 301 to the target slug', () => {
    assert.deepEqual(resolvePathRedirect(MAP, '/show/hamilton'), { pathname: '/show/hamilton-2015', status: 301 });
  });

  test('name-derived routes: <route>/<retired slug> → 301 to <route>/<live slug>, trailing slash and case tolerated', () => {
    assert.deepEqual(resolvePathRedirect(MAP, '/creative/no-l-coward'), { pathname: '/creative/noel-coward-2', status: 301 });
    assert.deepEqual(resolvePathRedirect(MAP, '/creative/No-L-Coward/'), { pathname: '/creative/noel-coward-2', status: 301 });
    assert.deepEqual(resolvePathRedirect(MAP, '/theater/caf-broadway-theatre'), { pathname: '/theater/cafe-broadway-theatre', status: 301 });
    assert.deepEqual(resolvePathRedirect(MAP, '/west-end/theater/no-l-coward-theatre'), { pathname: '/west-end/theater/noel-coward-theatre', status: 301 });
    assert.deepEqual(resolvePathRedirect(MAP, '/off-broadway/theater/repertorio-espa-ol-spanish-theatre-repertory'), {
      pathname: '/off-broadway/theater/repertorio-espanol-spanish-theatre-repertory',
      status: 301,
    });
    assert.deepEqual(resolvePathRedirect(MAP, '/cast/ren-ceballos'), { pathname: '/cast/rene-ceballos-2', status: 301 });
  });

  test('name-derived routes: a key from another family, a nested path, an index or an unknown slug falls through', () => {
    for (const p of [
      '/theater/no-l-coward-theatre',
      '/west-end/theater/caf-broadway-theatre',
      '/off-broadway/theater/no-l-coward-theatre',
      '/cast/no-l-coward',
      '/creative/ren-ceballos',
      '/creative/no-l-coward/extra',
      '/west-end/theater/no-l-coward-theatre/shows',
      '/creative',
      '/creative/',
      '/theater/',
      '/west-end/theater',
      '/west-end/theater/',
      '/off-broadway/theater/',
      '/cast/',
      '/creative/unknown-person',
      '/cast/critic:jose-sol-s',
      '/west-end/no-l-coward-theatre',
      '/theaters/caf-broadway-theatre',
    ]) {
      assert.equal(resolvePathRedirect(MAP, p), null, p);
    }
  });

  test('/show/<slug>/ (trailing slash) with a "~" entry → 302', () => {
    assert.deepEqual(resolvePathRedirect(MAP, '/show/cabaret/'), { pathname: '/show/cabaret-2024', status: 302 });
  });

  test('/critics/<retired slug> → 301 to the canonical critic page', () => {
    assert.deepEqual(resolvePathRedirect(MAP, '/critics/jose-sol-s'), { pathname: '/critics/jose-solis', status: 301 });
    assert.deepEqual(resolvePathRedirect(MAP, '/critics/Jose-Sol-S/'), { pathname: '/critics/jose-solis', status: 301 });
  });

  test('nested, index, unknown and unrelated paths fall through', () => {
    for (const p of [
      '/show/hamilton/extra',
      '/show/',
      '/show',
      '/show/critic:jose-sol-s',
      '/critics',
      '/critics/',
      '/critics/outlets',
      '/critics/outlets/nytimes',
      '/critics/unknown-person',
      '/critics/hamilton',
      '/about',
    ]) {
      assert.equal(resolvePathRedirect(MAP, p), null, p);
    }
  });
});

describe('getCriticBySlug alias fallback (real data/slug-redirects-compact.json)', () => {
  const criticKeys = Object.keys(compact).filter((k) => k.startsWith(CRITIC_REDIRECT_PREFIX));
  const skip = criticKeys.length === 0
    ? 'no critic aliases in data/slug-redirects-compact.json (registry absent when prebuild last ran)'
    : false;

  test('every emitted critic alias resolves: canonical exists, and the old slug resolves to it unless the old slug is still a live profile (exact match wins)', { skip }, () => {
    const live = new Set(getAllCriticSlugs());
    for (const key of criticKeys) {
      const oldSlug = key.slice(CRITIC_REDIRECT_PREFIX.length);
      const canonical = compact[key];
      const target = getCriticBySlug(canonical);
      assert.ok(target, `alias ${oldSlug} → ${canonical}: canonical slug does not resolve — fix data/critic-slug-aliases.json in the core-data repo`);
      assert.equal(target.slug, canonical);
      const viaAlias = getCriticBySlug(oldSlug);
      assert.ok(viaAlias, `alias ${oldSlug} must resolve`);
      if (!live.has(oldSlug)) {
        assert.equal(viaAlias, target, `retired slug ${oldSlug} must resolve to the canonical profile`);
      }
    }
  });

  test('an unknown slug is still undefined', () => {
    assert.equal(getCriticBySlug('no-such-critic-xyz-123'), undefined);
  });
});
