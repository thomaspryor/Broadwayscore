// BRO-5860: live-data check, run by check-corpus-drift.js AUDITS.
/**
 * TodayTix's API answers "3hr 12min (incl. two intermissions)" (192 min) for
 * listings with no run time; enrich-todaytix-runtimes.js wrote it as "3h 12m"
 * on 10 Met Opera / La MaMa rows before isPlaceholderRunningTime() stopped it.
 * This catches the stored value however it gets back in (an older writer, a
 * hand edit, a restored row). A real 3h 12m show on TodayTix would also trip
 * it: check the page, then exempt it here by id with the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const PLACEHOLDER = '3h 12m';
const EXEMPT = new Set([]);

test('no TodayTix-linked row stores the TodayTix placeholder runtime', () => {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(data) ? data : (data.shows || []);
  assert.ok(shows.length > 0, 'data/shows.json has no shows');
  const hits = shows
    .filter(s => s.todaytixId && s.runtime === PLACEHOLDER && !EXEMPT.has(s.id))
    .map(s => s.id);
  assert.deepEqual(hits, [], `runtime "${PLACEHOLDER}" is the TodayTix filler; clear it with a data/pending-fixes plan: ${hits.join(', ')}`);
});
