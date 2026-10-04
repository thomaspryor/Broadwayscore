// BRO-275: vercel.json show redirects pointing at renamed/retired slugs 404'd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findDeadShowRedirects } = require('./dead-show-redirects.js');

const live = new Set(['the-choir-of-man-marble-arch-off-west-end', 'the-music-man-2022']);
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
