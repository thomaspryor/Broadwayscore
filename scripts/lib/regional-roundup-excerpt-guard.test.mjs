// BRO-8455 item 1: URL-less NYC Theatre / NYSR roundup excerpts never count on a regional or tour row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNycRoundupExcerptOnLocalShow } = require('./regional-roundup-excerpt-guard.js');

const PURPOSE = { id: 'purpose-regional-2026', localOnly: true, category: 'regional', market: 'regional' };
const TOUR = { id: 'and-juliet-tour-2024', category: 'tour', market: 'tour' };
const BROADWAY = { id: 'purpose-2025', category: 'broadway', market: 'broadway' };

test('replay purpose-regional-2026: URL-less nyc-theatre excerpt is blocked', () => {
  assert.equal(isNycRoundupExcerptOnLocalShow({ source: 'nyc-theatre', url: null, nycTheatreExcerpt: 'x' }, PURPOSE), true);
});
test('NYSR-sourced URL-less file on a tour row is blocked', () => {
  assert.equal(isNycRoundupExcerptOnLocalShow({ source: 'nysr', url: '' }, TOUR), true);
  assert.equal(isNycRoundupExcerptOnLocalShow({ sources: ['nyc-theatre'] }, TOUR), true);
});
test('the same file on a Broadway row still counts', () => {
  assert.equal(isNycRoundupExcerptOnLocalShow({ source: 'nyc-theatre', url: null }, BROADWAY), false);
});
test('a regional review with a real URL is left to the other guards', () => {
  assert.equal(isNycRoundupExcerptOnLocalShow({ source: 'nyc-theatre', url: 'https://example.com/r', nycTheatreExcerpt: 'x' }, PURPOSE), false);
});
test('an ordinary URL-less regional review (no roundup source) is not touched', () => {
  assert.equal(isNycRoundupExcerptOnLocalShow({ source: 'bww-reviews', url: null }, PURPOSE), false);
});

test('class guard: the rebuild calls the guard (reverting the wiring fails this)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /isNycRoundupExcerptOnLocalShow\(data, showById\[showId\]\)/);
});
