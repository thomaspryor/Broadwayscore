import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DTLI_GUESS_MISS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-miss-'));
const cache = require('./dtli-guess-miss-cache.js');

test('unknown show is not skipped', () => {
  assert.equal(cache.guessedRecently('never-seen-2026'), false);
});

test('recorded miss is remembered per show only', () => {
  cache.recordGuessMiss('two-girls-off-broadway-2026');
  assert.equal(cache.guessedRecently('two-girls-off-broadway-2026'), true);
  assert.equal(cache.guessedRecently('the-ask-off-broadway-2026'), false);
});

test('entry older than the TTL expires', () => {
  cache.recordGuessMiss('old-show-2026');
  const dir = process.env.DTLI_GUESS_MISS_CACHE_DIR;
  const old = new Date(Date.now() - cache.GUESS_MISS_TTL_MS - 60000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  assert.equal(cache.guessedRecently('old-show-2026'), false);
});

test('outage runs are not definitive misses', () => {
  assert.equal(cache.isDefinitiveMiss(0, 10), false);
  assert.equal(cache.isDefinitiveMiss(4, 10), false);
  assert.equal(cache.isDefinitiveMiss(10, 10), true);
  assert.equal(cache.isDefinitiveMiss(0, 0), false);
});

test('searchDTLI wires the guard around the guess loop', () => {
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function searchDTLI'), src.indexOf('async function searchShowScore'));
  assert.ok(fn.indexOf('guessedRecently(show.id)') > fn.indexOf('discoverDtliSlug'), 'guard must come after sitemap discovery');
  assert.ok(fn.indexOf('guessedRecently(show.id)') < fn.indexOf('for (const slug of uniqueVariations)'));
  assert.ok(fn.includes('isDefinitiveMiss(answeredProbes'));
  assert.ok(fn.indexOf('recordGuessMiss(show.id)') > fn.indexOf('for (const slug of uniqueVariations)'));
});
