#!/usr/bin/env node
/**
 * backfill-original-production-id.js
 *
 * One-time correction for the bug fixed in discover-historical-shows.js
 * (scripts/lib/revival-chain.js): originalProductionId must point to the
 * chronologically EARLIEST production of a title, but 173/214 existing
 * shows.json entries pointed to a LATER one instead (discovered out of
 * chronological order). Groups all shows by title-slug, recomputes the
 * whole chain per group via assignRevivalChain(), and writes only the
 * entries whose originalProductionId or productionNumber actually change.
 *
 * Usage:
 *   node scripts/backfill-original-production-id.js --file=path/to/shows.json [--dry-run]
 *   node scripts/backfill-original-production-id.js [--dry-run]   # defaults to data/shows.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { slugify } = require('./lib/deduplication');
const { assignRevivalChain } = require('./lib/revival-chain');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-original-production-id.js — fix backward-pointing originalProductionId values.

Usage:
  node scripts/backfill-original-production-id.js [--file=path] [--dry-run]
  node scripts/backfill-original-production-id.js --help, -h   print this usage and exit
`;

function baseSlugOf(show) {
  return (show.slug || show.id).replace(/-\d{4}$/, '');
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find(a => a.startsWith('--file='));
  const filePath = fileArg
    ? path.resolve(fileArg.slice('--file='.length))
    : path.join(__dirname, '..', 'data', 'shows.json');

  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const shows = data.shows;

  // Group ALL shows by base slug first (so the true original — which often
  // has isRevival=false and no existing originalProductionId, e.g. "Hair"
  // 2011 vs the 1977 revival pointing at it — is present to chain against),
  // then only touch groups where at least one member already carries a
  // revival-chain signal. A base-slug collision between two members with NO
  // signal at all (coincidental slug match, unrelated shows) is left alone.
  const allGroups = new Map();
  for (const s of shows) {
    const base = baseSlugOf(s);
    if (!allGroups.has(base)) allGroups.set(base, []);
    allGroups.get(base).push(s);
  }
  const groups = new Map();
  for (const [base, group] of allGroups) {
    if (group.some(s => s.originalProductionId || s.isRevival)) {
      groups.set(base, group);
    }
  }

  let changedCount = 0;
  const changes = [];

  for (const [base, group] of groups) {
    if (group.length < 2) continue; // nothing to chain against
    const chain = assignRevivalChain(group.map(s => ({ id: s.id, openingDate: s.openingDate })));
    const chainById = new Map(chain.map(c => [c.id, c]));

    for (const s of group) {
      const c = chainById.get(s.id);
      const origChanged = (s.originalProductionId ?? null) !== c.originalProductionId;
      const numChanged = (s.productionNumber ?? null) !== c.productionNumber;
      if (origChanged || numChanged) {
        changes.push({
          id: s.id, base,
          before: { originalProductionId: s.originalProductionId ?? null, productionNumber: s.productionNumber ?? null },
          after: { originalProductionId: c.originalProductionId, productionNumber: c.productionNumber },
        });
        if (!dryRun) {
          s.originalProductionId = c.originalProductionId;
          s.productionNumber = c.productionNumber;
        }
        changedCount++;
      }
    }
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}${changedCount} show(s) corrected across ${groups.size} title group(s) scanned.`);
  for (const c of changes.slice(0, 30)) {
    console.log(`  ${c.id}: originalProductionId ${JSON.stringify(c.before.originalProductionId)} -> ${JSON.stringify(c.after.originalProductionId)}, productionNumber ${c.before.productionNumber} -> ${c.after.productionNumber}`);
  }
  if (changes.length > 30) console.log(`  ... and ${changes.length - 30} more`);

  if (!dryRun && changedCount > 0) {
    data._meta = data._meta || {};
    data._meta.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    console.log(`Wrote ${filePath}`);
  }
}

main();
