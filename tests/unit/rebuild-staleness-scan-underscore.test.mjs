// A plan delete moves review files into data/review-texts/_superseded-misattributed/.
// That folder is not a show, so the stale-checkout guard must not flag it as
// "scoreable files, zero reviews.json entries" (it failed rebuild-fast, 2026-10-16).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanDriftedShows } = require('../../scripts/lib/rebuild-staleness-scan.js');

test('underscore holding folders are never reported as missing shows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  fs.mkdirSync(path.join(dir, 'review-texts', '_superseded-misattributed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-texts', '_superseded-misattributed', 'a--b.json'),
    JSON.stringify({ outlet: 'A', criticName: 'B', fullText: 'x'.repeat(2000), assignedScore: 80, url: 'https://example.com/a' }));
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: [] }));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ reviews: [] }));
  const scan = scanDriftedShows(['_superseded-misattributed', '_pending'], dir);
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.missing, []);
  assert.deepEqual(scan.scoreableShowIds, []);
});
