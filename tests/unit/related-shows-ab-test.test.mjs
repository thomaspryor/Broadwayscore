// BRO-5989: related-shows-position A/B decisions, run against the real module.
// TESTS-VS-DERIVED-DATA-EXEMPT: pure functions over synthetic inputs, plus a structural source check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickCompactRelated, sampleSizePerArm, daysToReach, RELATED_SHOWS_FLAG } = require('../../scripts/lib/related-shows-ab.js');

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
const mk = (id) => ({ id, slug: id });

test('compact row never includes a noindex page, the page itself, or duplicates', () => {
  const noindex = new Set(['thin-closed']);
  const out = pickCompactRelated(
    [mk('self'), mk('a'), mk('thin-closed'), mk('a'), mk('b'), mk('c'), mk('d'), mk('e'), mk('f')],
    'self',
    (s) => !noindex.has(s.id),
  );
  assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'c', 'd', 'e']);
});

test('compact row is empty when every candidate is noindex', () => {
  assert.deepEqual(pickCompactRelated([mk('a')], 'self', () => false), []);
});

test('sample size for 15% -> 20% at alpha .05 / power .8 is 906 per arm', () => {
  assert.equal(sampleSizePerArm({ p1: 0.15, p2: 0.2 }), 906);
  assert.throws(() => sampleSizePerArm({ p1: 0.15, p2: 0.15 }));
});

test('days to reach: 906/arm at ~286 landers/day is 7 days; mobile-only (~180/day) is 11', () => {
  assert.equal(daysToReach(906, 8000 / 28), 7);
  assert.equal(daysToReach(906, 180), 11);
});

test('page wires the component and filters with isShowIndexable', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/show/[slug]/page.tsx'), 'utf8');
  assert.match(page, /<RelatedShowsCompactAB shows=\{compactRelated\}/);
  assert.match(page, /pickCompactRelated\(/);
  assert.match(page, /isShowIndexable\(s, s\.slug\)/);
  // reviews stay above the row
  assert.ok(page.indexOf('<ReviewsList') < page.indexOf('<RelatedShowsCompactAB'));
});

test('component reads the registered flag via the hook, mobile-gated', () => {
  const c = fs.readFileSync(path.join(root, 'src/components/RelatedShowsCompactAB.tsx'), 'utf8');
  assert.match(c, /usePostHogFlag\(RELATED_SHOWS_FLAG, eligible\)/);
  assert.match(c, /max-width: 639px/);
  assert.match(c, new RegExp(`const RELATED_SHOWS_FLAG = '${RELATED_SHOWS_FLAG}'`));
});
