#!/usr/bin/env node
/**
 * cleanup-we-cross-market.js — Delete cross-market contamination from WE review directories
 *
 * West End show directories accumulated Broadway reviews from title-matching aggregator
 * scrapers before market-aware guards existed. These files have wrongProduction: true
 * and are already excluded from scoring, but persist as dead weight.
 *
 * Classification:
 *   DELETE: US outlets (not London, not isDualMarket) with wrongProduction: true
 *   DELETE: Any file with wrongProductionNote (explicit confirmation of wrong production)
 *   KEEP:   London-region outlets with wrongProduction but no note (same-market wrong production)
 *   KEEP:   isDualMarket outlets with wrongProduction but no note (ambiguous)
 *
 * Usage:
 *   node scripts/cleanup-we-cross-market.js           # dry-run (report only)
 *   node scripts/cleanup-we-cross-market.js --execute  # actually delete files
 */

const { isLondonMarket } = require('./lib/venue-classification');
const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `cleanup-we-cross-market.js — Delete cross-market contamination from WE review directories.

Usage:
  node scripts/cleanup-we-cross-market.js [options]
  node scripts/cleanup-we-cross-market.js --help, -h    print this usage and exit
`;
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

const execute = process.argv.includes('--execute');

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  // Load shows.json to identify WE shows by category (not by glob pattern)
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const weShowIds = new Set(
    showsData.shows
      .filter(s => isLondonMarket(s.category))
      .map(s => s.id)
  );

  // Load outlet registry for market classification
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || {};

  const londonOutlets = new Set();
  const dualMarketOutlets = new Set();
  for (const [id, info] of Object.entries(outlets)) {
    if (info.region === 'london') londonOutlets.add(id);
    if (info.isDualMarket) dualMarketOutlets.add(id);
    for (const alias of (info.aliases || [])) {
      const al = alias.toLowerCase();
      if (info.region === 'london') londonOutlets.add(al);
      if (info.isDualMarket) dualMarketOutlets.add(al);
    }
  }

  // Also check directories that look like WE shows but aren't in shows.json
  // (orphan directories from deleted/renamed shows)
  const allDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const weDirs = allDirs.filter(d => weShowIds.has(d) || d.includes('-west-end'));

  // Stats
  let totalScanned = 0;
  let deleteCount = 0;
  let keepCount = 0;
  let noWrongProd = 0;
  const deletedFiles = [];
  const keptFiles = [];
  const perShow = {};

  for (const dir of weDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, dir);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        continue;
      }

      totalScanned++;

      if (!data.wrongProduction) {
        noWrongProd++;
        continue;
      }

      const outlet = (data.outletId || data.outlet || '').toLowerCase();
      const hasNote = !!data.wrongProductionNote;
      const isLondon = londonOutlets.has(outlet);
      const isDual = dualMarketOutlets.has(outlet);

      // KEEP: London outlet with no note (same-market wrong production)
      // KEEP: isDualMarket outlet with no note (ambiguous)
      if (!hasNote && (isLondon || isDual)) {
        keepCount++;
        keptFiles.push({ dir, file, outlet, reason: isLondon ? 'london-outlet' : 'dual-market' });
        continue;
      }

      // DELETE: everything else with wrongProduction: true
      // - Files with explicit notes (cross-show dedup, venue guard, date guard, etc.)
      // - US outlets without notes (clear cross-market contamination)
      deleteCount++;
      const reason = hasNote ? `note: ${data.wrongProductionNote.slice(0, 60)}` : `US outlet: ${outlet}`;
      deletedFiles.push({ dir, file, outlet, reason });

      if (!perShow[dir]) perShow[dir] = { deleted: 0, kept: 0 };
      perShow[dir].deleted++;

      if (execute) {
        fs.unlinkSync(filePath);
      }
    }
  }

  // Report
  console.log(`\n=== WE Cross-Market Cleanup ${execute ? '(EXECUTED)' : '(DRY RUN)'} ===\n`);
  console.log(`Scanned: ${totalScanned} files in ${weDirs.length} WE directories`);
  console.log(`Legitimate (no wrongProduction): ${noWrongProd}`);
  console.log(`DELETE: ${deleteCount}`);
  console.log(`KEEP (wrongProduction, same-market): ${keepCount}`);

  // Per-show breakdown (top 20)
  const showBreakdown = Object.entries(perShow)
    .sort((a, b) => b[1].deleted - a[1].deleted)
    .slice(0, 20);

  if (showBreakdown.length > 0) {
    console.log(`\nTop affected shows:`);
    for (const [show, counts] of showBreakdown) {
      console.log(`  ${counts.deleted.toString().padStart(3)} deleted  ${show}`);
    }
  }

  // KEEP details
  if (keptFiles.length > 0) {
    console.log(`\nKEPT files (${keptFiles.length}):`);
    for (const k of keptFiles) {
      console.log(`  ${k.dir}/${k.file} — ${k.reason}`);
    }
  }

  // Write report to /tmp for audit
  const report = {
    timestamp: new Date().toISOString(),
    executed: execute,
    totalScanned,
    noWrongProd,
    deleteCount,
    keepCount,
    deletedFiles,
    keptFiles,
  };
  fs.writeFileSync('/tmp/we-cleanup-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`\nFull report: /tmp/we-cleanup-report.json`);

  if (!execute) {
    console.log(`\nDRY RUN — no files deleted. Use --execute to delete.`);
  } else {
    console.log(`\n✓ ${deleteCount} files deleted.`);
  }

  // Check for empty directories after cleanup
  if (execute) {
    let emptyDirs = 0;
    for (const dir of weDirs) {
      const showDir = path.join(REVIEW_TEXTS_DIR, dir);
      const remaining = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
      if (remaining.length === 0) {
        emptyDirs++;
        console.log(`  ⚠️  ${dir} is now empty`);
      }
    }
    if (emptyDirs > 0) {
      console.log(`\n${emptyDirs} directories are now empty (may need cleanup).`);
    }
  }
}

main();
