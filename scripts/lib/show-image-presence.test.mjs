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
// statSync is injected alongside existsSync: the predicate also requires
// isFile(), so a fixture that stubs only existsSync would fall through to the
// real fs and fail for the wrong reason.
const opts = {
  repoRoot: ROOT,
  existsSync: (p) => ON_DISK.has(p),
  statSync: (p) => {
    if (!ON_DISK.has(p)) throw new Error(`ENOENT: ${p}`);
    return { isFile: () => true };
  },
};

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

test('a DIRECTORY never counts as an image', () => {
  // existsSync alone accepts a directory. That is the same false-all-clear
  // class this predicate exists to prevent, so it is pinned separately.
  const dir = '/repo/public/images/shows/high-society-west-end-2026';
  const o = {
    repoRoot: ROOT,
    existsSync: (p) => p === dir,
    statSync: () => ({ isFile: () => false }),
  };
  assert.equal(imagePresent('/images/shows/high-society-west-end-2026', o), false);
});

test('a ref cannot escape public/ via ..', () => {
  // Containment: '..' must never let this answer "present" about a file
  // outside public/, however real that file is.
  const o = { repoRoot: ROOT, existsSync: () => true, statSync: () => ({ isFile: () => true }) };
  assert.equal(imagePresent('/../package.json', o), false);
  assert.equal(imagePresent('/images/../../etc/hosts', o), false);
});

test('query strings, fragments and a public/ prefix resolve to the real file', () => {
  // Each of these used to false-WARN: a cache-buster or fragment was joined
  // into the filename, and a 'public/'-prefixed ref probed public/public/...
  const real = '/repo/public/images/shows/x/poster.jpg';
  const o = {
    repoRoot: ROOT,
    existsSync: (p) => p === real,
    statSync: () => ({ isFile: () => true }),
  };
  assert.equal(imagePresent('/images/shows/x/poster.jpg?mtime=123', o), true);
  assert.equal(imagePresent('/images/shows/x/poster.jpg#anchor', o), true);
  assert.equal(imagePresent('/public/images/shows/x/poster.jpg', o), true);
});

test('protocol-relative and data: refs are treated as remote, not as paths', () => {
  const boom = () => { throw new Error('must not touch the filesystem'); };
  const o = { repoRoot: ROOT, existsSync: boom, statSync: boom };
  assert.equal(imagePresent('//cdn.example.com/hero.jpg', o), true);
  assert.equal(imagePresent('data:image/png;base64,AAAA', o), true);
});

test('empty, missing and non-string references are not present', () => {
  for (const bad of [undefined, null, '', 0, false, {}, [], 42]) {
    assert.equal(imagePresent(bad, opts), false, `${JSON.stringify(bad)} must not read as present`);
  }
});

test('a public/-PREFIXED SIBLING directory is outside containment (BRO-2748)', () => {
  // The '..' tests above are satisfied by a containment check written as
  // `full.startsWith(publicDir)` with no path.sep — every path they probe
  // ('/repo/package.json', '/etc/hosts') fails that weaker check too, so
  // dropping the separator survived the whole suite.
  //
  // It is a false-ALL-CLEAR hole, the direction this predicate exists to
  // close: any sibling whose name merely STARTS WITH 'public' — public-old/,
  // public_backup/, publicity/ — resolves inside the weakened check while
  // living outside public/. No such sibling exists in the repo today, which
  // is exactly why only an injected filesystem can pin it.
  const o = {
    repoRoot: ROOT,
    // Every probed path "exists" and is a real file, so the ONLY thing that
    // can return false here is the containment check itself.
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
  };
  for (const escape of [
    '/../public-old/images/shows/x/hero.webp',
    '/../public_backup/images/shows/x/hero.webp',
    '/../publicity/hero.webp',
    '/../publicimages/hero.webp',
  ]) {
    assert.equal(
      imagePresent(escape, o),
      false,
      `${escape} resolves OUTSIDE public/ — a separator-less startsWith would call it present`
    );
  }
  // The other direction stays true: public/ itself, and paths under it, are
  // still contained. A containment fix that over-rejects would be its own bug.
  assert.equal(imagePresent('/images/shows/x/hero.webp', o), true);
});
