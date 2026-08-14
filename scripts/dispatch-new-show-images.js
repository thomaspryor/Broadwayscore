#!/usr/bin/env node
/**
 * dispatch-new-show-images.js — card #1456.
 *
 * Fires fetch-all-image-formats.yml (show_id-scoped) for shows that just
 * went live, so a new show doesn't sit imageless until the next twice-weekly
 * image cron. Wired into scrape-new-aggregators.yml's regional
 * auto-promotion step right after the existing reddit-sentiment/mezzanine
 * dispatches for the same $IDS.
 *
 * Usage:
 *   node scripts/dispatch-new-show-images.js --ids=show-a,show-b
 *   node scripts/dispatch-new-show-images.js   # reads data/audit/last-promotion-ids.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildImageDispatchInputs } = require('./lib/image-trigger-guard.js');
const { dispatchImageFetch } = require('./lib/dispatch-image-fetch.js');

const USAGE = `Usage: node scripts/dispatch-new-show-images.js [--ids=id1,id2]
  --ids=       Comma-separated show ids to dispatch image fetch for.
               Defaults to reading data/audit/last-promotion-ids.json.
`;

function loadIdsFromPromotionFile() {
  const file = path.join(__dirname, '..', 'data', 'audit', 'last-promotion-ids.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.promoted || []).map((p) => p.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const idsArg = process.argv.slice(2).find((a) => a.startsWith('--ids='));
  const ids = idsArg ? idsArg.slice('--ids='.length).split(',') : loadIdsFromPromotionFile();

  const dispatches = buildImageDispatchInputs(ids);
  if (!dispatches.length) {
    console.log('No show ids to dispatch image fetch for.');
    return;
  }

  let failed = 0;
  for (const d of dispatches) {
    const showId = d.inputs.show_id;
    const result = await dispatchImageFetch(showId);
    if (result.ok) {
      console.log(`✓ dispatched fetch-all-image-formats.yml for ${showId}`);
    } else {
      failed++;
      console.error(`✗ image-fetch dispatch failed for ${showId}: ${result.error}`);
    }
  }

  if (failed > 0) {
    console.error(`${failed}/${dispatches.length} image-fetch dispatch(es) failed — will still get picked up by the next scheduled sweep.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
