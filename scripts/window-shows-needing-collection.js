#!/usr/bin/env node
'use strict';
/**
 * BRO-7051: print (comma-separated) the opening-window shows (0-3 days past opening) that still
 * have review-text stubs with no collected text, most pending first, capped. The opening-window
 * workflow dispatches collect-review-texts.yml for each, so stubs get collected the same cycle
 * and push-review-texts hands urgent shows on to scoring. Usage: node scripts/window-shows-needing-collection.js [--limit N]
 */
const fs = require('fs');
const path = require('path');
const ow = require('./lib/outlet-opening-window');
const { shouldRetryFetch } = require('./lib/review-guards');

const i = process.argv.indexOf('--limit');
const limit = i > -1 ? parseInt(process.argv[i + 1], 10) || 3 : 3;
const root = process.env.WINDOW_DATA_ROOT || path.join(__dirname, '..', 'data');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'shows.json'), 'utf8'));
const win = ow.selectWindowShows(Array.isArray(raw) ? raw : raw.shows);
const byShow = {};
for (const s of win) {
  const dir = path.join(root, 'review-texts', s.id);
  if (!fs.existsSync(dir)) continue;
  byShow[s.id] = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'failed-fetches.json')
    .map((f) => { try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (r && typeof r === 'object') r.reviewId = r.reviewId || `${s.id}/${f}`; return r; } catch { return null; } })
    .filter(Boolean);
}
const ledger = {};
try {
  for (const e of JSON.parse(fs.readFileSync(path.join(root, 'review-texts', 'failed-fetches.json'), 'utf8'))) if (e && e.reviewId) ledger[e.reviewId] = e;
} catch { /* no ledger yet: nothing has failed */ }
console.log(ow.showsNeedingCollection(win, byShow, limit, { ledger, shouldRetryFetch }).join(','));
