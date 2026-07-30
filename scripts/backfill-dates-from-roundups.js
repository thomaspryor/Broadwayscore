#!/usr/bin/env node
/**
 * backfill-dates-from-roundups — fill MISSING opening-night dates from
 * roundup-article facts (Sprint A4, v2 reconciler plan).
 *
 * The Broad Strokes class (2026-07-29): a TodayTix-discovered stub carried
 * openingDate:null + a wrong previewsStartDate, and no process ever corrected
 * it — the show page showed no opening date even after reviews landed. This
 * script closes the metadata half of that class: for each show that has
 * fresh review-evidence (see lib/review-evidence.js) AND a null openingDate,
 * fetch the roundup article, parse the standard "began previews <date>,
 * officially opening <date> ... through <date>" facts, and fill ONLY the
 * null fields.
 *
 * Write policy (deliberately conservative — plan-review consensus):
 *   - NEVER overwrites a non-null date. Human corrections, IBDB enrichment,
 *     and prior backfills always win. PROTECTED_FIELDS semantics extend,
 *     they are not replaced.
 *   - openingDateSource is stamped only when openingDate itself is written.
 *   - shows.json is written via atomicWriteShowsJson (shrink gate + symlink-
 *     safe rename). Caller (workflow) runs validate-data.js before pushing.
 *
 * Selection does NOT depend on this script succeeding — the evidence-anchored
 * arm in opening-night-selection.js fires on evidence alone. This is display/
 * metadata correctness, not the discovery path.
 */

const USAGE = `backfill-dates-from-roundups.js — fill null show dates from roundup articles

Usage:
  node scripts/backfill-dates-from-roundups.js [--dry-run] [--limit=N] [--show=ID]

Options:
  --dry-run     Print what would be written; no shows.json write
  --limit=N     Max shows to process (default 10 per run)
  --show=ID     Only this show id
  --help, -h    Show this help

Exit codes: 0 = ran (0+ backfills); 1 = fatal error.`;

function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }

  const fs = require('fs');
  const path = require('path');
  const { fetchPage } = require('./lib/scraper');
  const { extractOpeningFactsFromArticle } = require('./lib/reverse-discovery');
  const { loadReviewEvidence } = require('./lib/review-evidence');
  const { atomicWriteShowsJson } = require('./lib/atomic-shows-write');

  const dryRun = argv.includes('--dry-run');
  const limit = parseInt((argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '10', 10);
  const onlyShow = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;

  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = showsData.shows || showsData;
  const byId = new Map(shows.map(s => [s.id || s.slug, s]));

  const evidence = loadReviewEvidence();
  // Source preference: Playbill roundups carry the standardized dates
  // sentence; BWW/WET roundups state opening dates less consistently, so
  // they're tried only when no Playbill item exists for the show.
  const SOURCE_ORDER = ['playbill-roundup', 'bww-roundup', 'wet-roundup'];

  const targets = [];
  for (const [showId, e] of Object.entries(evidence)) {
    if (onlyShow && showId !== onlyShow) continue;
    const show = byId.get(showId);
    if (!show || show.openingDate) continue; // non-null openingDate = nothing to do
    const items = [...(e.items || [])].sort(
      (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
    );
    if (items.length > 0) targets.push({ show, item: items[0] });
  }
  console.log(`${targets.length} show(s) with fresh evidence and null openingDate` +
    (targets.length > limit ? ` (processing first ${limit})` : ''));

  let backfilled = 0;
  for (const { show, item } of targets.slice(0, limit)) {
    try {
      const page = await fetchPage(item.url);
      const text = String(page.content || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      const facts = extractOpeningFactsFromArticle(text, item.date);
      const changes = {};
      if (facts.openingDate && !show.openingDate) {
        changes.openingDate = facts.openingDate;
        changes.openingDateSource = item.source === 'playbill-roundup' ? 'playbill-article' : item.source;
      }
      if (facts.previewsStartDate && !show.previewsStartDate) changes.previewsStartDate = facts.previewsStartDate;
      if (facts.closingDate && !show.closingDate) changes.closingDate = facts.closingDate;
      if (Object.keys(changes).length === 0) {
        console.log(`  ${show.id}: no fillable facts parsed from ${item.url}`);
        continue;
      }
      console.log(`  ${show.id}: ${JSON.stringify(changes)}${dryRun ? ' (dry-run)' : ''}`);
      if (!dryRun) { Object.assign(show, changes); backfilled++; }
    } catch (e) {
      console.error(`  ${show.id}: fetch/parse failed — ${e.message}`);
    }
  }

  if (backfilled > 0) {
    atomicWriteShowsJson(showsPath, showsData);
    console.log(`Wrote shows.json (${backfilled} show(s) backfilled). Run validate-data.js before pushing.`);
  } else if (!dryRun) {
    console.log('No backfills — shows.json untouched.');
  }
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, hasHelpFlag, USAGE };
