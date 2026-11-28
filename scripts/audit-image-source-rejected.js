#!/usr/bin/env node
/**
 * audit-image-source-rejected.js
 *
 * BRO-4901: lists every show field (poster/thumbnail/hero) that points at a
 * local file whose recorded source in data/image-sources.json is one of the
 * show's own rejectedImageUrls. That means either the file is wrong-production
 * art, or someone fixed the file by hand and did not update the map (the map
 * then tells the archiver to re-download the rejected art if the file goes
 * missing). Fix: clear the field, or record the real source / "manual:<note>".
 *
 * BRO-7846: also lists TodayTix catalogue art that cannot be the row's own
 * (closed before TodayTix sold tickets, or beside a rejected TodayTix source).
 *
 * Read-only.
 *
 * Usage:
 *   node scripts/audit-image-source-rejected.js [--json] [--strict] [--alert]
 *     --strict   exit 1 when any row is found (default: always exit 0)
 *     --alert    file/refresh one worker card via owner-alert-router, clear it when clean
 *                (BRO-7182; empty shows.json or image-sources map makes no decision)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findRejectedSourcesInUse } = require('./lib/image-source-match');
const { loadImageSources } = require('./lib/image-sources-store');
const { hasHelpFlag } = require('./lib/cli-help.js');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

async function main(args) {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const sources = loadImageSources();
  const rows = findRejectedSourcesInUse(shows, sources);
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`${rows.length} in-use image field(s) whose recorded source is a rejected URL or another production's TodayTix art`);
    for (const r of rows) console.log(`  ${r.id}.${r.format}: ${r.path} <- ${r.source} (${r.why})`);
  }
  if (args.includes('--alert')) {
    const { decideImageSourceRejectedAlert } = require('./lib/strict-audit-alerts');
    const { routeAuditDecisions } = require('./lib/audit-alert');
    const sourcesCount = sources && typeof sources === 'object' ? Object.keys(sources).length : 0;
    const decisions = decideImageSourceRejectedAlert({ rows, showsCount: shows.length, sourcesCount });
    if (!decisions.length) console.log('[image-source-rejected] --alert skipped: shows.json or image-sources map is empty');
    await routeAuditDecisions(decisions, 'audit-image-source-rejected');
  }
  return args.includes('--strict') && rows.length ? 1 : 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/audit-image-source-rejected.js [--json] [--strict] [--alert]');
    process.exit(0);
  }
  main(args).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 3; });
}
