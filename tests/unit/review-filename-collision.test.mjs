import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { resolveIngestFilename, versionedReviewFilename } = require('../../scripts/lib/ingest-collision.js');

const base = 'nytimes--jesse-green.json';

test('different URL, same critic+outlet: versioned filename, never the base', () => {
  const r = resolveIngestFilename({ filename: base, existingData: { url: 'https://nyt.com/a' }, url: 'https://nyt.com/b' });
  assert.equal(r.versioned, true);
  assert.notEqual(r.filename, base);
  assert.match(r.filename, /^nytimes--jesse-green-[0-9a-f]{6}\.json$/);
  assert.equal(r.existingUrl, 'https://nyt.com/a');
});

test('same URL (modulo utm/trailing slash/host case): plain update of the same file', () => {
  const r = resolveIngestFilename({ filename: base, existingData: { url: 'https://NYT.com/a/' }, url: 'https://nyt.com/a?utm_source=x' });
  assert.equal(r.versioned, false);
  assert.equal(r.filename, base);
});

test('no existing file: base filename', () => {
  assert.equal(resolveIngestFilename({ filename: base, existingData: null, url: 'https://x/y' }).filename, base);
});

test('versioned filename is deterministic per URL and distinct across URLs', () => {
  assert.equal(versionedReviewFilename(base, 'https://x/1'), versionedReviewFilename(base, 'https://x/1'));
  assert.notEqual(versionedReviewFilename(base, 'https://x/1'), versionedReviewFilename(base, 'https://x/2'));
});

test('route is wired to the helper (no inline overwrite regression)', () => {
  const src = fs.readFileSync(new URL('../../src/app/api/admin/ingest-review/route.ts', import.meta.url), 'utf8');
  assert.match(src, /resolveIngestFilename\(\{ filename, existingData, url \}\)/);
});
