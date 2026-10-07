import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildTombstoneRows, writeTombstones } = require('./merge-tombstones.js');
const { mergeReviewsJson } = require('./merge-reviews-json.js');

const row = (criticName, extra = {}) => ({
  showId: 's', outlet: 'Radio Times', outletId: 'radio-times', criticName,
  url: 'https://www.radiotimes.com/a/review/', assignedScore: 80, ...extra,
});

test('a fossil dropped by the merge is persisted as a JSONL audit row', () => {
  const ours = { _meta: { lastUpdated: '2026-10-02T00:00:00Z' }, reviews: [row('Olivia Garrett', { fullText: 'x'.repeat(500) })] };
  const remote = { _meta: { lastUpdated: '2026-10-01T00:00:00Z' }, reviews: [row('Unknown')] };
  const { stats } = mergeReviewsJson(ours, remote);
  assert.equal(stats.unknownBylineFossilsDropped, 1);
  const rows = buildTombstoneRows('reviews.json', stats, new Date('2026-10-05T00:00:00Z'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].supersededBy, 'Olivia Garrett');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tomb-')), 'd');
  const a = writeTombstones(dir, rows);
  const b = writeTombstones(dir, rows);
  assert.notEqual(a, b, 'each run writes its own file, so racing rebases cannot conflict');
  const lines = fs.readFileSync(a, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'unknown-byline-fossil');
});

test('no deletions, no file write', () => {
  assert.equal(writeTombstones('/nonexistent/x', buildTombstoneRows('r', { unknownBylineFossilsDroppedKeys: [] })), null);
});
