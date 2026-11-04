/**
 * persistReviewSnapshot() cross-market (class A) check, BRO-6983.
 *
 * The collector fills in a review's page date through persistReviewSnapshot,
 * which writes with a bare fs.writeFileSync. safeWriteReview's class-A check
 * never ran, so a sibling production's review landed live in
 * maybe-happy-ending-2024 on 2026-11-03 (and re-reddened the zero-tolerance
 * audit after two earlier manual fixes). These tests use the REAL
 * persistReviewSnapshot and the REAL guard predicate (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { _setShowsCacheForTest } = require('./review-write-guard.js');
const { readReviewForUpdate, persistReviewSnapshot } = require('./persist-review-snapshot.js');

const TRYOUT = 'the-outsiders-world-premiere-regional-2023'; // opened 2023-03-07
const BROADWAY = 'the-outsiders-2024'; // opened 2024-04-11

function seed() {
  _setShowsCacheForTest(new Map([
    [TRYOUT, { id: TRYOUT, title: 'The Outsiders', openingDate: '2023-03-07' }],
    [BROADWAY, { id: BROADWAY, title: 'The Outsiders', openingDate: '2024-04-11' }],
  ]));
}

// Seed an existing file, read it the way the collector does, set a date, persist.
function persistDate(onDisk, newDate, extra = {}) {
  seed();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-xmarket-'));
  const dir = path.join(root, TRYOUT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'theatrely--joey-sims.json');
  fs.writeFileSync(file, JSON.stringify({ criticName: 'Joey Sims', outletId: 'theatrely', url: 'https://example.com/a', ...onDisk }, null, 2));
  const data = readReviewForUpdate(file);
  data.publishDate = newDate;
  data.dateSource = 'html-page';
  Object.assign(data, extra);
  persistReviewSnapshot({ filePath: file, data }, () => {});
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('BRO-6983 replay: collector fills a dateless file with the sibling production\'s date -> stamped wrongProduction', () => {
  const out = persistDate({}, '2024-04-11');
  assert.equal(out.wrongProduction, true);
  assert.match(out.wrongProductionNote, /^Auto-flagged \(cross-market\)/);
  assert.equal(out.publishDate, '2024-04-11', 'date is kept, the record is flagged in place');
});

test('a page date near the folder show\'s own opening is untouched', () => {
  const out = persistDate({}, '2023-03-08');
  assert.equal(out.wrongProduction, undefined);
});

test('a date that was already class A before this write is left to the audit', () => {
  const out = persistDate({ publishDate: '2024-04-10' }, '2024-04-11');
  assert.equal(out.wrongProduction, undefined);
});

test('_auditAllowCrossMarket opts the record out', () => {
  const out = persistDate({ _auditAllowCrossMarket: true }, '2024-04-11');
  assert.equal(out.wrongProduction, undefined);
});

test('an unchanged date is never re-judged (enrichment writes do not re-fire)', () => {
  const out = persistDate({ publishDate: '2024-04-11', wrongProductionOverride: true }, '2024-04-11');
  assert.equal(out.wrongProduction, undefined);
});

test('a human override or lock is respected', () => {
  assert.equal(persistDate({ wrongProductionOverride: true }, '2024-04-11').wrongProduction, undefined);
  assert.equal(persistDate({ _locked: true }, '2024-04-11').wrongProduction, undefined);
});

test('a show with no same-title sibling can never trip it', () => {
  _setShowsCacheForTest(new Map([['solo-show-2024', { id: 'solo-show-2024', title: 'Solo Show', openingDate: '2024-01-10' }]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-solo-'));
  const dir = path.join(root, 'solo-show-2024');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'a--b.json');
  fs.writeFileSync(file, JSON.stringify({ criticName: 'B', outletId: 'a', url: 'https://example.com/z' }));
  const data = readReviewForUpdate(file);
  data.publishDate = '2025-12-01';
  persistReviewSnapshot({ filePath: file, data }, () => {});
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).wrongProduction, undefined);
});

// Review finding (BRO-6983): the audit exempts tour productions (BRO-6114); so must this.
test('a tour production is exempt, as in the audit', () => {
  _setShowsCacheForTest(new Map([
    ['hp-tour-2024', { id: 'hp-tour-2024', title: 'Harry Potter', openingDate: '2024-09-01', category: 'tour' }],
    ['hp-west-end-2026', { id: 'hp-west-end-2026', title: 'Harry Potter', openingDate: '2026-10-21', category: 'west-end' }],
  ]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-tour-'));
  const dir = path.join(root, 'hp-tour-2024');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'a--b.json');
  fs.writeFileSync(file, JSON.stringify({ criticName: 'B', outletId: 'a', url: 'https://example.com/z' }));
  const data = readReviewForUpdate(file);
  data.publishDate = '2026-10-25';
  persistReviewSnapshot({ filePath: file, data }, () => {});
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).wrongProduction, undefined);
});
