#!/usr/bin/env node
/**
 * probe-historical-backfill-yield.js — does the repeat cycle of the daily
 * historical review backfill pay for itself? (BRO-7551)
 *
 * On-demand probe, read-only. The backfill (historical-backfill.yml) wraps to a
 * new cycle after the last show. Shows at list positions below the cursor were
 * revisited this cycle; the rest are an untouched control. A revisited show's
 * yield is the review files whose firstSeenAt is on or after its estimated
 * visit day. The control's rate is background intake (opening-night and other
 * pipelines), so the net return of a repeat pass is visited minus control.
 *
 * Usage: node scripts/probe-historical-backfill-yield.js [--json]
 * Needs data/review-texts (setup-local-data / cloud-bootstrap) and the cursor.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { measureYield } = require('./historical-backfill-next');

const ROOT = path.join(__dirname, '..');

function loadFirstSeen(ids, dir) {
  const out = {};
  for (const id of ids) {
    const d = path.join(dir, id);
    if (!fs.existsSync(d)) continue;
    out[id] = [];
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        // Not new reviews: excluded from scoring, or a URL correction that reset firstSeenAt.
        if (j.wrongProduction || j.wrongShow || j.isRoundupArticle || j.duplicateOf || j.firstSeenAtPriorUrl) continue;
        const t = new Date(j.firstSeenAt).getTime();
        if (!Number.isFinite(t)) continue;
        out[id].push(t);
      } catch { /* skip */ }
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log('Usage: node scripts/probe-historical-backfill-yield.js [--json]'); return; }
  const all = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/backfill-batches.json'), 'utf8')).flat())];
  const cursor = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audit/historical-backfill-cursor.json'), 'utf8'));
  const textsDir = require('./lib/review-texts-env-dir').reviewTextsDirFromEnv(path.join(ROOT, 'data/review-texts'));
  // BRO-8323: a missing review-texts checkout used to print "0 shows ... -> low-yield",
  // a verdict to stop the backfill drawn from no data. Refuse instead.
  if (!fs.existsSync(textsDir) || fs.readdirSync(textsDir).length === 0) {
    console.error(`No review data at ${textsDir} (run scripts/setup-local-data.sh); no verdict.`);
    process.exit(2);
  }
  const r = measureYield(all, cursor, loadFirstSeen(all, textsDir));
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`cycle ${cursor.cycle} since ${r.cycleStart}, cursor ${cursor.next}/${cursor.total}`);
  console.log(`revisited: ${r.visited.shows} shows, ${r.visited.newSinceVisit} new reviews (${r.visitedPerShow.toFixed(2)}/show/30d)`);
  console.log(`control:   ${r.control.shows} shows, ${r.control.newSinceCycleStart} new reviews (${r.controlPerShow.toFixed(2)}/show/30d)`);
  console.log(`assumes: ${r.assumption}; per visited show: ${r.visited.shows ? (r.visited.newSinceVisit / r.visited.shows).toFixed(2) : 0} new reviews`);
  console.log(`net yield ${r.netPerShow.toFixed(2)} reviews/show/30d -> ${r.verdict}`);
}

if (require.main === module) main();
