#!/usr/bin/env node
/**
 * Audit data/aggregator-archive/{show-score,dtli}/ for sibling-misfiled pages
 * (BRO-2121): an archive HTML saved under show X that is really a same-title
 * sibling's page. Uses the same detector the extractors use
 * (scripts/lib/sibling-misfile.js), so a page this lists is exactly a page the
 * extractors would REJECT.
 *
 * Usage: node scripts/audit-sibling-misfile-archive.js [--delete [--expect=N]] [--archive=DIR] [--json]
 *   (default)  read-only report; exit 1 if any misfiled page found
 *   --delete   unlink the misfiled HTML files AND tombstone each id in
 *              <archive>/<aggregator>/_not-found.json. Without the tombstone the
 *              weekly scrape-dtli-show-score.yml sees "no archive file" and
 *              re-fetches the same sibling page (fetch-aggregator-pages.ts skips
 *              known-not-found ids unless --force). Exits 1 if anything was found,
 *              exit 0 on success (2 on a missing
 *              archive or an --expect=N mismatch, deleting nothing).
 *   --archive  override the archive root (default data/aggregator-archive)
 */
const fs = require('fs');
const path = require('path');
const { detectSiblingMisfile } = require('./lib/sibling-misfile');
const { buildSiblingIndex } = require('./lib/market-routing');
const { loadNotFoundForAggregator, saveNotFoundForAggregator } = require('./lib/not-found-cache');

const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const USAGE = `audit-sibling-misfile-archive.js — find (and with --delete, remove + tombstone) sibling-misfiled Show Score/DTLI archive pages.

Usage:
  node scripts/audit-sibling-misfile-archive.js [--archive=DIR] [--json]
  node scripts/audit-sibling-misfile-archive.js --delete [--archive=DIR]
  node scripts/audit-sibling-misfile-archive.js --help, -h`;

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const list = raw.shows || raw;
  return Array.isArray(list) ? list : Object.values(list);
}

/** Scan one archive root. Returns [{aggregator, showId, file, targetId, count, total}]. */
function scanArchive(archiveRoot, { shows, extractShowData, extractReviewsFromDTLI }) {
  const siblingIndex = buildSiblingIndex(shows);
  const byId = new Map(shows.map(s => [s.id, s]));
  const hits = [];
  for (const aggregator of ['show-score', 'dtli']) {
    const dir = path.join(archiveRoot, aggregator);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.html')).sort()) {
      const showId = f.replace(/\.html$/, '');
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      let reviews;
      if (aggregator === 'show-score') {
        const data = extractShowData(html, showId, null);
        if (!data) continue;
        const v = data._siblingMisfile; // the shared detector's verdict, set only by the sibling-misfile branch
        if (v && v.misfiled) hits.push({ aggregator, showId, file: path.join(dir, f), targetId: v.targetId, count: v.count, total: v.total });
        continue;
      }
      reviews = extractReviewsFromDTLI(html, showId);
      const v = detectSiblingMisfile(showId, reviews, { category: byId.get(showId)?.category, siblingIndex });
      if (v.misfiled) hits.push({ aggregator, showId, file: path.join(dir, f), targetId: v.targetId, count: v.count, total: v.total });
    }
  }
  return hits;
}

/** Unlink each hit's HTML and record its id in that aggregator's not-found cache. */
function deleteAndTombstone(archiveRoot, hits, today = new Date().toISOString().split('T')[0]) {
  const caches = {};
  for (const h of hits) {
    caches[h.aggregator] = caches[h.aggregator] || loadNotFoundForAggregator(archiveRoot, h.aggregator);
    caches[h.aggregator][h.showId] = today;
  }
  // Tombstones first: a throw mid-way leaves tombstoned pages still present, never deleted
  // pages the weekly scrape would re-fetch (BRO-4779 review).
  for (const [agg, cache] of Object.entries(caches)) saveNotFoundForAggregator(archiveRoot, agg, cache);
  for (const h of hits) fs.unlinkSync(h.file);
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const archiveArg = args.find(a => a.startsWith('--archive='));
  const archiveRoot = archiveArg ? path.resolve(archiveArg.slice(10)) : path.join(ROOT, 'data/aggregator-archive');
  const deleting = args.includes('--delete');
  if (!fs.existsSync(archiveRoot)) {
    // Under --delete a missing archive is a silent no-op in CI (BRO-4779): fail loudly.
    if (deleting) { console.error(`archive not present at ${archiveRoot}: refusing a no-op --delete`); process.exitCode = 2; return; }
    console.log(`archive not present at ${archiveRoot} — nothing to audit`);
    return;
  }
  const hits = scanArchive(archiveRoot, {
    shows: loadShows(),
    extractShowData: require('./extract-show-score-reviews').extractShowData,
    extractReviewsFromDTLI: require('./extract-dtli-reviews').extractReviewsFromDTLI,
  });
  const json = args.includes('--json');
  const log = json ? console.error : console.log; // keep stdout pure JSON
  if (json) console.log(JSON.stringify(hits));
  else for (const h of hits) console.log(`${h.aggregator}\t${h.showId}\t-> ${h.targetId} (${h.count}/${h.total})`);
  log(`\n${hits.length} sibling-misfiled archive page(s)`);
  if (deleting) {
    // --expect=N guards against a partial checkout deleting/finding the wrong set.
    // Required: the CI checkout always creates the archive dir, so only --expect catches an empty one.
    const expectArg = args.find(a => a.startsWith('--expect='));
    if (!expectArg || !/^\d+$/.test(expectArg.slice(9))) {
      console.error('--delete requires --expect=N (the number of misfiled pages the plan author saw)');
      process.exitCode = 2;
      return;
    }
    if (hits.length !== Number(expectArg.slice(9))) {
      console.error(`expected ${expectArg.slice(9)} misfiled page(s), found ${hits.length}: nothing deleted`);
      process.exitCode = 2;
      return;
    }
    deleteAndTombstone(archiveRoot, hits);
    log(`deleted ${hits.length} file(s) and tombstoned their ids in _not-found.json`);
    return; // a successful delete is exit 0 so the approved-fix executor counts it applied
  }
  if (hits.length) process.exitCode = 1;
}

module.exports = { scanArchive, deleteAndTombstone };
if (require.main === module) main();
