// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-7080 (replays BRO-6438 Benjamin Button 27 vs 24 and BRO-6202 Other Desert
 * Cities 36 vs 32): countLocalIncluded must drop what the rebuild drops inside a
 * show, or the opening-night drift check alerts on every show with a duplicate
 * stub or a syndicated copy. Logic is require()'d (CLAUDE.md §15).
 *
 * Run: node --test scripts/lib/review-count-probe-dedup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { countLocalIncluded } = require('./review-count-probe');

const SHOW = { id: 'probe-show-2026', title: 'Probe Show', category: 'off-broadway', venue: 'Hall', openingDate: '2026-10-04' };

function review(outletId, criticName, over = {}) {
  return {
    showId: SHOW.id, outletId, outlet: outletId, criticName, url: `https://${outletId}.test/${String(criticName).replace(/\s+/g, '-')}`,
    publishDate: '2026-10-05', assignedScore: 70, fullText: `a considered review by ${criticName} `.repeat(40), contentTier: 'complete', ...over,
  };
}

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-dedup-'));
  fs.mkdirSync(path.join(root, SHOW.id), { recursive: true });
  for (const [name, data] of files) fs.writeFileSync(path.join(root, SHOW.id, name), JSON.stringify(data));
  return root;
}

test('an unknown-critic stub beside a named critic at the same outlet counts once', () => {
  const root = fixture([
    ['nysr--unknown.json', review('nysr', 'Unknown', { url: 'https://nysr.test/other', fullText: null, dtliExcerpt: 'A fine evening.', contentTier: 'excerpt' })],
    ['nysr--david-finkle.json', review('nysr', 'David Finkle')],
  ]);
  assert.equal(countLocalIncluded(SHOW.id, root, SHOW).included, 1);
});

test('a second file with the same review URL counts once', () => {
  const r = review('vulture', 'Sara Holdren');
  const root = fixture([
    ['vulture--sara-holdren.json', r],
    ['vulture--sara-holdren-2.json', { ...r, criticName: 'Sara  Holdren' }],
  ]);
  assert.equal(countLocalIncluded(SHOW.id, root, SHOW).included, 1);
});

test('distinct critics at distinct outlets all count', () => {
  const root = fixture([
    ['nysr--david-finkle.json', review('nysr', 'David Finkle')],
    ['vulture--sara-holdren.json', review('vulture', 'Sara Holdren')],
    ['nytimes--jesse-green.json', review('nytimes', 'Jesse Green')],
  ]);
  assert.equal(countLocalIncluded(SHOW.id, root, SHOW).included, 3);
});
