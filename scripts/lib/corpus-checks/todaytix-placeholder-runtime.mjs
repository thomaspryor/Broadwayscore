// BRO-5860 / BRO-7594: live-data check, run by check-corpus-drift.js AUDITS.
/**
 * TodayTix's API answers a filler runningTime for listings with no run time
 * (PLACEHOLDER_RUNNING_TIMES in scripts/lib/todaytix-runtime.js):
 *   "3hr 12min (incl. two intermissions)" -> stored "3h 12m"   (BRO-5860, 10 rows)
 *   "1hr 35mins (inc. interval)"          -> stored "1h 35m"   (BRO-7594, London)
 *   "1hr 35min (no intermission)"         -> stored "1h 35m"   (BRO-7594, NYC)
 *   "4hrs (inc two intervals)"            -> stored "4h"       (BRO-7594, Awake and Sing!)
 * 78 rows carried one on 2026-11-16. This catches the stored value however it
 * gets back in (an older writer, a hand edit, a restored row). A real show
 * with that run time also trips it: check the TodayTix page, then add it to
 * STORED_FILLER_EXEMPT in scripts/lib/todaytix-runtime.js with the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { storedFillerRows } = require('../todaytix-runtime.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

test('no TodayTix-linked row stores a TodayTix placeholder runtime', () => {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(data) ? data : (data.shows || []);
  assert.ok(shows.length > 0, 'data/shows.json has no shows');
  const hits = storedFillerRows(shows);
  assert.deepEqual(hits, [], `TodayTix filler runtime stored; clear it with a data/pending-fixes plan: ${hits.join(', ')}`);
});
