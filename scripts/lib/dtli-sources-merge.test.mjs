import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { applyDtliExcerpt } = createRequire(import.meta.url)('./dtli-sources-merge.js');

const dtli = { excerpt: 'x'.repeat(40), thumb: 'Down', url: 'https://example.com/r' };

test('adds dtli to sources and keeps the primary source (mj-2022 broadwaynews shape)', () => {
  const r = { source: 'serp-discovery', sources: ['serp-discovery'] };
  assert.equal(applyDtliExcerpt(r, dtli), true);
  assert.deepEqual(r.sources, ['serp-discovery', 'dtli']);
  assert.equal(r.source, 'serp-discovery');
  assert.equal(r.dtliThumb, 'Down');
  assert.equal(r.url, 'https://example.com/r');
});

test('row with no sources array gets source plus dtli', () => {
  const r = { source: 'web-search' };
  applyDtliExcerpt(r, dtli);
  assert.deepEqual(r.sources, ['web-search', 'dtli']);
});

test('row with neither source nor sources gets sources only; source stays unset', () => {
  const r = {};
  applyDtliExcerpt(r, dtli);
  assert.deepEqual(r.sources, ['dtli']);
  assert.equal(r.source, undefined);
});

test('existing real excerpt is kept but the row still gets dtli provenance', () => {
  const r = { source: 'a', sources: ['a'], dtliExcerpt: 'y'.repeat(30) };
  assert.equal(applyDtliExcerpt(r, dtli), true);
  assert.deepEqual(r.sources, ['a', 'dtli']);
  assert.equal(r.dtliExcerpt, 'y'.repeat(30));
});

test('excerpt and dtli both already present is a no-op', () => {
  const r = { source: 'a', sources: ['a', 'dtli'], dtliExcerpt: 'y'.repeat(30) };
  assert.equal(applyDtliExcerpt(r, dtli), false);
});

test('no duplicate dtli entry', () => {
  const r = { source: 'dtli', sources: ['dtli'], dtliExcerpt: 'short' };
  applyDtliExcerpt(r, dtli);
  assert.deepEqual(r.sources, ['dtli']);
});
