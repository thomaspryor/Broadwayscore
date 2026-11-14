// Card #282 (Notion 3a5637c5-416f-81fa-be50-c295d1ce6fb1): a WET roundup for
// the 2026 West End revival of High Society (Barbican Theatre, Felicity
// Kendal) was going unmatched because only the 1998 Broadway production was
// catalogued. A *global*, unscoped title index treats "High Society" as
// already covered by the Broadway entry and silently swallows the WE miss —
// same failure class as Midnight at the Never Get (task #281). The fix
// (already shipped generically, scripts/lib/reverse-discovery.js
// buildShowTitleIndex market scoping) is exercised here against the real
// title/market pair that motivated this card, so a regression in market
// scoping is caught by name, not just by the generic Moulin Rouge fixture in
// reverse-discovery.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildShowTitleIndex,
  titleMatchesIndex,
  findUnmatchedCandidates,
} = require('../../scripts/lib/reverse-discovery.js');

// Real catalogue shape (category/market fields as committed to shows.json).
const BROADWAY_1998_ONLY = [
  { id: 'high-society-1998', title: 'High Society', slug: 'high-society-1998', category: 'broadway', market: 'broadway', status: 'closed' },
];

const BOTH_PRODUCTIONS = [
  ...BROADWAY_1998_ONLY,
  { id: 'high-society-west-end-2026', title: 'High Society', slug: 'high-society-west-end-2026', category: 'off-west-end', market: 'west-end', status: 'closed' },
];

const WET_ROUNDUP_ITEM = { title: 'High Society', source: 'wet-roundup', url: 'https://www.westendtheatre.com/357319/news/reviews/high-society-reviews/' };

test('High Society: an UNSCOPED index wrongly treats the WE roundup as already covered', () => {
  // This is the bug class the card describes: without market scoping, the
  // 1998 Broadway entry alone is enough to match "High Society" globally.
  const globalIndex = buildShowTitleIndex(BROADWAY_1998_ONLY);
  assert.equal(titleMatchesIndex('High Society', globalIndex), true);
});

test('High Society: market-scoped WE index correctly surfaces the 2026 revival as missing (pre-fix state)', () => {
  const weIndex = buildShowTitleIndex(BROADWAY_1998_ONLY, 'we');
  assert.equal(titleMatchesIndex('High Society', weIndex), false);
  assert.deepEqual(
    findUnmatchedCandidates([WET_ROUNDUP_ITEM], weIndex).map((c) => c.title),
    ['High Society']
  );
});

test('High Society: after adding high-society-west-end-2026, the WE index matches and the detector no longer flags it', () => {
  const weIndex = buildShowTitleIndex(BOTH_PRODUCTIONS, 'we');
  assert.equal(titleMatchesIndex('High Society', weIndex), true);
  assert.deepEqual(findUnmatchedCandidates([WET_ROUNDUP_ITEM], weIndex), []);
});

test('High Society: the 1998 Broadway production stays independently matched in the NYC index (no cross-contamination)', () => {
  const nycIndex = buildShowTitleIndex(BOTH_PRODUCTIONS, 'nyc');
  assert.equal(titleMatchesIndex('High Society', nycIndex), true);
  // The WE-only entry must not leak into the NYC index.
  const nycIds = new Set();
  for (const entries of nycIndex.statusByVariant.values()) {
    for (const e of entries) nycIds.add(e.id);
  }
  assert.equal(nycIds.has('high-society-west-end-2026'), false);
  assert.ok(nycIds.has('high-society-1998'));
});
