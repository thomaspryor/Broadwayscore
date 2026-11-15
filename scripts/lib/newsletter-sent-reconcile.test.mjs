// Tests for newsletter-sent-reconcile.js — require() the real functions.
// Regression for 2026-11-15: conflicted shows.json -> empty show list ->
// verify-sent-vs-state --fix wiped last week's featuredShowIds.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildSlugIndex, parseShowsText, fixRefusal } = require_('./newsletter-sent-reconcile.js');

const CONFLICTED = `{
  "_meta": {
<<<<<<< Updated upstream
    "lastUpdated": "2026-11-15T13:36:35.016Z",
=======
    "lastUpdated": "2026-11-15T09:29:41.393Z",
>>>>>>> Stashed changes
  },
  "shows": [{ "id": "hamilton-2015", "slug": "hamilton" }]
}`;

test('conflicted shows.json throws (names the conflict) instead of returning no shows', () => {
  assert.throws(() => parseShowsText(CONFLICTED, 'shows.json'), /conflict markers/);
});

test('empty or shapeless show list throws', () => {
  assert.throws(() => buildSlugIndex({ shows: [] }), /no shows/);
  assert.throws(() => buildSlugIndex({}), /no shows/);
  assert.throws(() => buildSlugIndex(null), /no shows/);
});

test('valid show list maps slug to id', () => {
  const m = parseShowsText(JSON.stringify({ shows: [{ id: 'hamilton-2015', slug: 'hamilton' }, { id: 'x' }] }));
  assert.equal(m.get('hamilton'), 'hamilton-2015');
  assert.equal(m.size, 1);
});

test('refuses a fix when most sent slugs are unmapped (the 0-of-28 wipe)', () => {
  assert.match(fixRefusal({ sentSlugCount: 28, mappedCount: 0 }), /refusing/);
  assert.match(fixRefusal({ sentSlugCount: 10, mappedCount: 4 }), /refusing/);
});

test('allows a fix when the lookup is healthy or nothing was sent', () => {
  assert.equal(fixRefusal({ sentSlugCount: 28, mappedCount: 28 }), null);
  assert.equal(fixRefusal({ sentSlugCount: 10, mappedCount: 5 }), null);
  assert.equal(fixRefusal({ sentSlugCount: 0, mappedCount: 0 }), null);
});

test('verify-sent-vs-state.mjs uses the strict loader and the fix refusal (no empty-list fallback)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'newsletter', 'verify-sent-vs-state.mjs'), 'utf8');
  assert.match(src, /parseShowsText\(/);
  assert.match(src, /fixRefusal\(/);
  assert.doesNotMatch(src, /loadJson\(SHOWS_PATH/);
});

test('refresh-drafts.sh stops when the core-data pull leaves conflicts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'newsletter', 'refresh-drafts.sh'), 'utf8');
  assert.match(src, /diff --name-only --diff-filter=U/);
});
