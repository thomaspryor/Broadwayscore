import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildWpLiveIndex, isLiveScored } = require('../../scripts/lib/wp-live-scored-check.js');

const norm = {
  normalizeOutlet: s => String(s || '').toLowerCase().trim(),
  normalizeUrl: s => String(s || '').toLowerCase().replace(/\/+$/, ''),
  normalizeCritic: s => { const v = String(s || '').toLowerCase().trim(); return v === 'unknown' ? '' : v; },
};
const live = [
  { showId: 's1', outletId: 'nyt', url: 'https://x.com/a/', criticName: 'Jane Doe' },
  { showId: 's1', outletId: 'vulture', url: '', criticName: 'Sam Roe' },
];
const idx = buildWpLiveIndex(live, norm);

test('live by normalized URL', () => {
  assert.equal(isLiveScored(idx, { showId: 's1', outletId: 'NYT', url: 'https://x.com/a', criticName: 'Jane Doe' }, norm), true);
});
test('shared URL, different critic: sibling live entry does not hide this file', () => {
  assert.equal(isLiveScored(idx, { showId: 's1', outletId: 'nyt', url: 'https://x.com/a', criticName: 'Other Person' }, norm), false);
});
test('URL match with same critic is live', () => {
  assert.equal(isLiveScored(idx, { showId: 's1', outletId: 'nyt', url: 'https://x.com/a', criticName: 'jane doe' }, norm), true);
});
test('critic-only fallback applies only to files without a URL', () => {
  assert.equal(isLiveScored(idx, { showId: 's1', outletId: 'vulture', url: '', criticName: 'sam roe' }, norm), true);
  assert.equal(isLiveScored(idx, { showId: 's1', outletId: 'vulture', url: 'https://v.com/z', criticName: 'sam roe' }, norm), false);
});
test('not live: different show or outlet', () => {
  assert.equal(isLiveScored(idx, { showId: 's2', outletId: 'nyt', url: 'https://x.com/a', criticName: 'Jane Doe' }, norm), false);
  assert.equal(isLiveScored(idx, { showId: 's1', outletId: 'variety', url: 'https://x.com/a', criticName: 'Jane Doe' }, norm), false);
});
test('unnamed critic never matches on name alone', () => {
  const i2 = buildWpLiveIndex([{ showId: 's1', outletId: 'nyt', url: 'https://x.com/u', criticName: 'Unknown' }], norm);
  assert.equal(isLiveScored(i2, { showId: 's1', outletId: 'nyt', url: 'https://other', criticName: 'Unknown' }, norm), false);
});
test('empty live set is never live', () => {
  assert.equal(isLiveScored(buildWpLiveIndex([], norm), { showId: 's1', outletId: 'nyt', url: 'u', criticName: 'a' }, norm), false);
});
