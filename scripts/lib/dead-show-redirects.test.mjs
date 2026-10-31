// BRO-275: vercel.json show redirects pointing at renamed/retired slugs 404'd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findDeadShowRedirects } = require('./dead-show-redirects.js');

const live = new Set(['the-choir-of-man-marble-arch-off-west-end', 'the-choir-of-man-off-west-end', 'the-music-man-2022']);
const map = { 'the-music-man': '~the-music-man-2022', 'the-choir-of-man-off-west-end-2026': 'the-choir-of-man-off-west-end' };

test('flags only /show/ redirects whose destination is neither live nor a map key', () => {
  const redirects = [
    { source: '/show/the-choir-of-man', destination: '/show/the-choir-of-man-west-end' }, // dead (real 2026-10-04 case)
    { source: '/show/choir', destination: '/show/the-choir-of-man-marble-arch-off-west-end' }, // live slug
    { source: '/show/music-man', destination: '/show/the-music-man' }, // map key forwards on
    { source: '/show/x', destination: '/show/the-choir-of-man-off-west-end-2026/' }, // map key, trailing slash
    { source: '/show/:slug-2024', destination: '/show/:slug' }, // parameterised: ignored
    { source: '/director/:path*', destination: '/creative/:path*' }, // not a show route
  ];
  assert.deepEqual(findDeadShowRedirects(redirects, live, map).map(r => r.source), ['/show/the-choir-of-man']);
});

test('map chains must end at a live slug; cycles and retired ends are dead; ids are alive', () => {
  const m = { a: 'b', b: '~the-music-man-2022', c: 'retired-slug', d: 'e', e: 'd' };
  const redirects = [
    { source: '/show/1', destination: '/show/a' },
    { source: '/show/2', destination: '/show/c' },
    { source: '/show/3', destination: '/show/d' },
    { source: '/show/4', destination: '/show/new-show-2026' },
  ];
  assert.deepEqual(findDeadShowRedirects(redirects, live, m, new Set(['new-show-2026'])).map(r => r.source), ['/show/2', '/show/3']);
});

test('a destination that is another live hardcoded redirect source is alive', () => {
  const redirects = [
    { source: '/show/la-traviata', destination: '/show/la-traviata-off-broadway' },
    { source: '/show/la-traviata-off-broadway', destination: '/opera/la-traviata' },
    { source: '/show/q', destination: '/show/r' },
    { source: '/show/r', destination: '/show/gone' },
  ];
  assert.deepEqual(findDeadShowRedirects(redirects, live, {}).map(r => r.source), ['/show/q', '/show/r']);
});
