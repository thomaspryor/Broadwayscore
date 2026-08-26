/**
 * the-gin-game-2026 phantom-path regression (2026-07-31).
 *
 * A shows.json entry carried /images/shows/the-gin-game-2026/poster.jpg with
 * NO file behind it. Every monitor asked `if (!show.images?.poster)`, a phantom
 * path is truthy, so the show was reported "covered" while it sat live for two
 * weeks rendering the emoji placeholder — and auto-fix-show-data.js therefore
 * never set needs_images, withholding the re-fetch that would have fixed it.
 *
 * Requires the REAL predicate (CLAUDE.md rule 15) — no re-implemented logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { declaredImageResolves, hasRealImage, PLACEHOLDER_FILE_HASHES } = require('../../scripts/lib/show-images.js');
const { getMarketSearchKeyword } = require('../../scripts/lib/market-label.js');

// Scratch public/ tree: images/shows/real-show/poster.webp exists, phantom does not.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'show-images-'));
const realDir = path.join(tmp, 'images', 'shows', 'real-show');
fs.mkdirSync(realDir, { recursive: true });
fs.writeFileSync(path.join(realDir, 'poster.webp'), Buffer.from('not-a-placeholder-image'));
const opts = { publicDir: tmp };

test('phantom local path (no file on disk) is NOT present', () => {
  assert.equal(declaredImageResolves('/images/shows/the-gin-game-2026/poster.jpg', opts), false);
});

test('local path with a real file on disk IS present', () => {
  assert.equal(declaredImageResolves('/images/shows/real-show/poster.webp', opts), true);
});

test('null/empty paths are not present', () => {
  assert.equal(declaredImageResolves(null, opts), false);
  assert.equal(declaredImageResolves(undefined, opts), false);
  assert.equal(declaredImageResolves('', opts), false);
  assert.equal(declaredImageResolves('   ', opts), false);
});

test('external URL is assumed live (we do not HEAD every CDN URL)', () => {
  assert.equal(declaredImageResolves('https://cdn.example.com/poster.jpg', opts), true);
});

test('protocol-relative URL is external, not a local path', () => {
  // `//cdn/x.jpg` starts with '/' but is a real external URL. Resolving it
  // against public/ would report it permanently missing (2026-07-31 review).
  assert.equal(declaredImageResolves('//images.squarespace-cdn.com/x.png', opts), true);
});

test('a byte-identical known placeholder on disk is NOT a real image', () => {
  // Write a file, register ITS hash as a placeholder, and assert the predicate
  // rejects it — proving the hash check actually runs, not just that the
  // registry is non-empty.
  const body = Buffer.from('pretend-coming-soon-graphic');
  const md5 = crypto.createHash('md5').update(body).digest('hex');
  const p = path.join(realDir, 'fake-placeholder.webp');
  fs.writeFileSync(p, body);
  assert.equal(declaredImageResolves('/images/shows/real-show/fake-placeholder.webp', opts), true,
    'sanity: unregistered file counts as real');
  PLACEHOLDER_FILE_HASHES.add(md5);
  try {
    assert.equal(declaredImageResolves('/images/shows/real-show/fake-placeholder.webp', opts), false,
      'a file whose hash is registered as a placeholder must NOT count as a real image');
  } finally {
    PLACEHOLDER_FILE_HASHES.delete(md5);
    fs.unlinkSync(p);
  }
});

test('the real placeholder registry stays populated', () => {
  assert.ok(PLACEHOLDER_FILE_HASHES.size >= 6, 'placeholder hash registry must stay populated');
});

test('hasRealImage: phantom paths in every role → false (the Gin Game shape)', () => {
  const ginGame = {
    images: {
      poster: '/images/shows/the-gin-game-2026/poster.jpg',
      thumbnail: '/images/shows/the-gin-game-2026/thumbnail.jpg',
      hero: '/images/shows/the-gin-game-2026/hero.jpg',
    },
  };
  assert.equal(hasRealImage(ginGame, opts), false);
});

test('hasRealImage: one real role is enough', () => {
  assert.equal(hasRealImage({ images: { poster: '/images/shows/real-show/poster.webp' } }, opts), true);
});

test('hasRealImage: missing images object → false', () => {
  assert.equal(hasRealImage({}, opts), false);
  assert.equal(hasRealImage({ images: null }, opts), false);
});

// --- image search keyword must follow the market, not default to Broadway ---

test('search keyword follows the market for every real category', () => {
  assert.equal(getMarketSearchKeyword('broadway'), 'Broadway');
  assert.equal(getMarketSearchKeyword('off-broadway'), 'Off-Broadway');
  assert.equal(getMarketSearchKeyword('west-end'), 'West End');
  // 294 shows carry off-west-end; they were being searched as Broadway.
  assert.equal(getMarketSearchKeyword('off-west-end'), 'Off-West End');
  assert.equal(getMarketSearchKeyword('regional'), 'theater');
});

test('unknown slug degrades to neutral "theater", never to Broadway', () => {
  assert.equal(getMarketSearchKeyword('dublin-fringe'), 'theater');
});

test('absent category still means Broadway (the corpus default)', () => {
  assert.equal(getMarketSearchKeyword(undefined), 'Broadway');
  assert.equal(getMarketSearchKeyword(null), 'Broadway');
});
