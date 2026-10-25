/**
 * BRO-5789: a script that creates a review-texts show folder must check the id
 * against shows.json (or go through review-file-writer). Orphan folders
 * (report-orphan-review-folders --strict, BRO-5288) were minted by scripts that
 * did not. A new folder-minting script fails here until it does the same or is
 * listed with the reason its ids can only come from shows.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../../scripts/', import.meta.url).pathname;
const MKDIR = /mkdirSync\(\s*(showDir|targetDir|toDir|childDir)\b/;
const GUARD = /review-file-writer|live-show-ids|knownShowIds/;
const ALLOW = {
  'sweep-we-aggregators.js': 'iterates shows.json rows (show.id)',
  'extract-theatre-record.js': 'iterates shows.json rows (show.id)',
  'backfill-outlet-from-sitemap.js': 'showId comes from slug-matching shows.json titles',
  'audit-pre2005-reviews.js': 'mkdir only after showById.has(suggestedShowId)',
  'classify-wrong-production.js': 'mkdir only after showById.has(targetShowId)',
  'fetch-opera-images.js': 'writes images, not review-text folders',
};

test('every script that mkdirs a review show folder guards the id', () => {
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!MKDIR.test(src)) continue;
    if (GUARD.test(src) || ALLOW[f]) continue;
    offenders.push(f);
  }
  assert.deepEqual(offenders, [], `unguarded review-folder writers: ${offenders.join(', ')}`);
});

test('the allowlist holds no stale entries', () => {
  for (const f of Object.keys(ALLOW)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(MKDIR.test(src), `${f} no longer mints a folder: drop it from ALLOW`);
    assert.ok(!GUARD.test(src), `${f} now guards the id: drop it from ALLOW`);
  }
});
