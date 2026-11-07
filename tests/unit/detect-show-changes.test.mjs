// BRO-2437: detect-show-changes.js must read the opening-night consensus text
// through the shared getShowConsensusText() helper, so a show keyed by slug
// (or carrying only the legacy `.consensus` field) is not silently omitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { detectChanges } = require(path.join(REPO, 'scripts/detect-show-changes.js'));

const prev = { 'show-1': { status: 'previews', score: null, reviewCount: 0 } };
const curr = { 'show-1': { status: 'open', score: 80, reviewCount: 4 } };
const showsMap = { 'show-1': { id: 'show-1', slug: 'show-one-2026', type: 'musical', venue: 'Hall' } };

function consensusTextFor(consensus) {
  const changes = detectChanges(curr, prev, { consensus, showsMap });
  const opening = changes['show-1'].find(c => c.type === 'opening-night');
  assert.ok(opening, 'opening-night change expected');
  return opening.consensusText;
}

test('consensus keyed by show id is found', () => {
  assert.equal(consensusTextFor({ shows: { 'show-1': { text: 'By id' } } }), 'By id');
});

test('consensus keyed by slug (id lookup misses) is found', () => {
  assert.equal(consensusTextFor({ shows: { 'show-one-2026': { text: 'By slug' } } }), 'By slug');
});

test('legacy .consensus field is found when .text is absent', () => {
  assert.equal(consensusTextFor({ shows: { 'show-1': { consensus: 'Legacy field' } } }), 'Legacy field');
});

test('no consensus entry for the show yields null, not a throw', () => {
  assert.equal(consensusTextFor({ shows: {} }), null);
  assert.equal(consensusTextFor(undefined), null);
});
