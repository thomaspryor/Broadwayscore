/**
 * pickWinnerImage — the Tony canon feed must not list art that was never
 * downloaded (doubt-2005 and i-am-my-own-wife-2003 404'd on web Stats and in
 * the app, BRO-6170). Runs the REAL helper from scripts/generate-stats-canon.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickWinnerImage } = require('../../scripts/generate-stats-canon.js');

const pub = mkdtempSync(path.join(tmpdir(), 'canon-img-'));
mkdirSync(path.join(pub, 'images/shows/has-thumb'), { recursive: true });
writeFileSync(path.join(pub, 'images/shows/has-thumb/thumbnail.jpg'), 'x');

test('skips a listed poster whose file is missing and falls back to an existing thumbnail', () => {
  const img = pickWinnerImage({ poster: '/images/shows/has-thumb/poster.jpg', thumbnail: '/images/shows/has-thumb/thumbnail.jpg' }, pub);
  assert.match(img, /^\/images\/shows\/has-thumb\/thumbnail\.jpg\?v=[0-9a-f]{8}$/);
});

test('returns null when every listed local file is missing', () => {
  assert.equal(pickWinnerImage({ poster: null, thumbnail: '/images/shows/doubt-2005/thumbnail.jpg' }, pub), null);
});

test('passes remote URLs through and tolerates no images', () => {
  assert.equal(pickWinnerImage({ poster: 'https://cdn.example.com/p.jpg' }, pub), 'https://cdn.example.com/p.jpg');
  assert.equal(pickWinnerImage(undefined, pub), null);
});
