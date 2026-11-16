#!/usr/bin/env node
/**
 * audit-historical-backfill-yield.js — does the repeat cycle of the daily
 * historical review backfill pay for itself? (BRO-7551)
 *
 * On-demand probe, read-only. The backfill (historical-backfill.yml) wraps to a
 * new cycle after the last show. Shows at list positions below the cursor were
 * revisited this cycle; the rest are an untouched control. A revisited show's
 * yield is the review files whose firstSeenAt is on or after its estimated
 * visit day. The control's rate is background intake (opening-night and other
 * pipelines), so the net return of a repeat pass is visited minus control.
 *
 * Usage: node scripts/audit-historical-backfill-yield.js [--json]
 * Needs data/review-texts (setup-local-data / cloud-bootstrap) and the cursor.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const DAY = 86400000;
const ROOT = path.join(__dirname, '..');

/**
 * Pure. `all` ordered show ids, `cursor` {next,updatedAt}, `firstSeenByShow`
 * id -> array of ms timestamps (NaN allowed), `perDay` shows visited per run.
 * Returns per-show rates for visited vs control plus the net per-show yield.
 */
function measureYield(all, cursor, firstSeenByShow, perDay = 24) {
  const end = new Date(cursor.updatedAt).getTime();
  const cycleStart = end - Math.ceil(cursor.next / perDay) * DAY;
  const v = { shows: 0, files: 0, newSinceVisit: 0 };
  const c = { shows: 0, files: 0, newSinceCycleStart: 0 };
  all.forEach((id, i) => {
    const stamps = firstSeenByShow[id];
    if (!stamps) return;
    if (i < cursor.next) {
      const visitDay = cycleStart + Math.floor(i / perDay) * DAY;
      v.shows++; v.files += stamps.length;
      v.newSinceVisit += stamps.filter((t) => t >= visitDay).length;
    } else {
      c.shows++; c.files += stamps.length;
      c.newSinceCycleStart += stamps.filter((t) => t >= cycleStart).length;
    }
  });
  const rate = (n, d) => (d ? n / d : 0);
  const visitedPerShow = rate(v.newSinceVisit, v.shows);
  const controlPerShow = rate(c.newSinceCycleStart, c.shows);
  return {
    cycleStart: new Date(cycleStart).toISOString().slice(0, 10),
    visited: v,
    control: c,
    visitedPerShow,
    controlPerShow,
    netPerShow: visitedPerShow - controlPerShow,
    verdict: visitedPerShow > 2 * controlPerShow && v.newSinceVisit > 0 ? 'keep' : 'low-yield',
  };
}

function loadFirstSeen(ids, dir) {
  const out = {};
  for (const id of ids) {
    const d = path.join(dir, id);
    if (!fs.existsSync(d)) continue;
    out[id] = [];
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try { out[id].push(new Date(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).firstSeenAt).getTime()); } catch { /* skip */ }
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log('Usage: node scripts/audit-historical-backfill-yield.js [--json]'); return; }
  const all = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/backfill-batches.json'), 'utf8')).flat())];
  const cursor = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audit/historical-backfill-cursor.json'), 'utf8'));
  const r = measureYield(all, cursor, loadFirstSeen(all, path.join(ROOT, 'data/review-texts')));
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`cycle ${cursor.cycle} since ${r.cycleStart}, cursor ${cursor.next}/${cursor.total}`);
  console.log(`revisited: ${r.visited.shows} shows, ${r.visited.newSinceVisit} new reviews (${r.visitedPerShow.toFixed(2)}/show)`);
  console.log(`control:   ${r.control.shows} shows, ${r.control.newSinceCycleStart} new reviews (${r.controlPerShow.toFixed(2)}/show)`);
  console.log(`net yield ${r.netPerShow.toFixed(2)} reviews/show -> ${r.verdict}`);
}

if (require.main === module) main();
module.exports = { measureYield };
