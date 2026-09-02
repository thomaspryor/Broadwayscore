/**
 * check-opening-night-readiness.js's image check has now shipped as a bug in
 * BOTH directions. These tests pin the direction that matters on an
 * opening-night gate: never report ALL CLEAR for an image that is not there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// require() the real predicate — never a copy (CLAUDE.md rule 15).
const { imagePresent } = require('./show-image-presence.js');

// Injected filesystem: only these paths "exist". Mirrors the real
// high-society-west-end-2026 state that produced the false all-clear —
// images.hero points at hero.webp, but only poster.jpg and thumbnail.jpg are
// on disk.
const ROOT = '/repo';
const ON_DISK = new Set([
  '/repo/public/images/shows/high-society-west-end-2026/poster.jpg',
  '/repo/public/images/shows/high-society-west-end-2026/thumbnail.jpg',
]);
const opts = { repoRoot: ROOT, existsSync: (p) => ON_DISK.has(p) };

test('a reference whose file is MISSING is not present (the false all-clear)', () => {
  assert.equal(
    imagePresent('/images/shows/high-society-west-end-2026/hero.webp', opts),
    false,
    'images.hero was SET but hero.webp is not on disk — this must not read as present'
  );
});

test('a reference whose file EXISTS is present (no false WARN)', () => {
  // The bug in the other direction: the original check hardcoded .webp and so
  // reported real .jpg files as missing. Both must pass.
  assert.equal(imagePresent('/images/shows/high-society-west-end-2026/poster.jpg', opts), true);
  assert.equal(imagePresent('/images/shows/high-society-west-end-2026/thumbnail.jpg', opts), true);
});

test('a leading slash is optional', () => {
  assert.equal(imagePresent('images/shows/high-society-west-end-2026/poster.jpg', opts), true);
});

test('remote URLs are trusted on the field alone, with no filesystem hit', () => {
  // A readiness check must not fire a network request per image, and must not
  // consult the filesystem for a URL either.
  const boom = () => { throw new Error('existsSync must not be called for a remote URL'); };
  for (const url of ['https://cdn.example.com/hero.webp', 'HTTP://cdn.example.com/a.jpg']) {
    assert.equal(imagePresent(url, { repoRoot: ROOT, existsSync: boom }), true);
  }
});

test('empty, missing and non-string references are not present', () => {
  for (const bad of [undefined, null, '', 0, false, {}, [], 42]) {
    assert.equal(imagePresent(bad, opts), false, `${JSON.stringify(bad)} must not read as present`);
  }
});
