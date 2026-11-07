/**
 * countLocalIncluded must count the reviews a returning show inherits from its
 * declared earlier-run entry (BRO-4759), or check-opening-night-drift reads
 * "live ahead of local" on every returning show. Logic is require()'d, never
 * copied (CLAUDE.md §15).
 *
 * Run: node --test scripts/lib/review-count-probe-inherit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { countLocalIncluded } = require('./review-count-probe');

const OLDER = { id: 'run-a-2026', title: 'Run A', category: 'off-broadway', venue: 'First Hall', openingDate: '2026-02-11', closingDate: '2026-02-21' };
const NEWER = {
  id: 'run-a-return-2026', title: 'Run A', category: 'off-broadway', venue: 'Second Hall', openingDate: '2026-10-04',
  priorRuns: [{ openingDate: '2026-02-11', closingDate: '2026-02-21', venue: 'First Hall' }],
};

function review(showId, outletId, over = {}) {
  return {
    showId, outletId, outlet: outletId, criticName: `Critic ${outletId}`, url: `https://${outletId}.test/review`,
    publishDate: '2026-02-12', assignedScore: 70, fullText: 'a considered review '.repeat(40), contentTier: 'complete', ...over,
  };
}

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-inherit-'));
  for (const [showId, name, data] of files) {
    fs.mkdirSync(path.join(root, showId), { recursive: true });
    fs.writeFileSync(path.join(root, showId, name), JSON.stringify(data));
  }
  return root;
}

test('counts in-window reviews inherited from the earlier-run entry', () => {
  const root = fixture([
    [NEWER.id, 'own--c.json', review(NEWER.id, 'own', { publishDate: '2026-10-05' })],
    [OLDER.id, 'a--c.json', review(OLDER.id, 'a')],
    [OLDER.id, 'b--c.json', review(OLDER.id, 'b')],
  ]);
  const r = countLocalIncluded(NEWER.id, root, NEWER, [OLDER, NEWER]);
  assert.equal(r.included, 3);
  assert.equal(r.inherited, 2);
});

test('without the shows list the count is the folder alone (back-compat)', () => {
  const root = fixture([
    [NEWER.id, 'own--c.json', review(NEWER.id, 'own', { publishDate: '2026-10-05' })],
    [OLDER.id, 'a--c.json', review(OLDER.id, 'a')],
  ]);
  assert.equal(countLocalIncluded(NEWER.id, root, NEWER).included, 1);
});

test('out-of-window and duplicate (same URL / same outlet+critic) earlier reviews are not counted', () => {
  const root = fixture([
    [NEWER.id, 'own--c.json', review(NEWER.id, 'own', { publishDate: '2026-10-05', url: 'https://dup.test/review' })],
    [NEWER.id, 'same--c.json', review(NEWER.id, 'same', { publishDate: '2026-09-24' })],
    [OLDER.id, 'dupurl--c.json', review(OLDER.id, 'dupurl', { url: 'https://dup.test/review' })],
    [OLDER.id, 'same--c.json', review(OLDER.id, 'same', { url: 'https://same.test/feb' })],
    [OLDER.id, 'late--c.json', review(OLDER.id, 'late', { publishDate: '2026-10-05' })],
  ]);
  const r = countLocalIncluded(NEWER.id, root, NEWER, [OLDER, NEWER]);
  assert.equal(r.inherited, 0);
  assert.equal(r.included, 2);
});

test('a show with no priorRuns link never reads another entry folder', () => {
  const root = fixture([
    [OLDER.id, 'a--c.json', review(OLDER.id, 'a')],
    ['solo-2026', 'own--c.json', review('solo-2026', 'own', { publishDate: '2026-10-05' })],
  ]);
  const solo = { id: 'solo-2026', title: 'Solo', category: 'off-broadway', openingDate: '2026-10-04' };
  const r = countLocalIncluded(solo.id, root, solo, [OLDER, solo]);
  assert.equal(r.included, 1);
  assert.equal(r.inherited, 0);
});
