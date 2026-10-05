#!/usr/bin/env node
/**
 * Audit data/aggregator-archive/{show-score,dtli}/ for sibling-misfiled pages
 * (BRO-2121): an archive HTML saved under show X that is really a same-title
 * sibling's page. Uses the same detector the extractors use
 * (scripts/lib/sibling-misfile.js), so a page this lists is exactly a page the
 * extractors would REJECT.
 *
 * Usage: node scripts/audit-sibling-misfile-archive.js [--delete] [--archive=DIR] [--json]
 *   (default)  read-only report; exit 1 if any misfiled page found
 *   --delete   unlink the misfiled HTML files (archives are regenerable derived
 *              data; the extractor guards keep re-fetches from re-polluting)
 *   --archive  override the archive root (default data/aggregator-archive)
 */
const fs = require('fs');
const path = require('path');
const { detectSiblingMisfile } = require('./lib/sibling-misfile');
const { buildSiblingIndex } = require('./lib/market-routing');

const ROOT = path.join(__dirname, '..');

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
        if (data._rejectAll) {
          const m = /date-match sibling (\S+?)'s opening/.exec(data._rejectionReason || '');
          const c = /sibling-misfile: (\d+)\/(\d+)/.exec(data._rejectionReason || '');
          hits.push({ aggregator, showId, file: path.join(dir, f), targetId: m && m[1], count: c ? +c[1] : 0, total: c ? +c[2] : 0 });
        }
        continue;
      }
      reviews = extractReviewsFromDTLI(html, showId);
      const v = detectSiblingMisfile(showId, reviews, { category: byId.get(showId)?.category, siblingIndex });
      if (v.misfiled) hits.push({ aggregator, showId, file: path.join(dir, f), targetId: v.targetId, count: v.count, total: v.total });
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const archiveArg = args.find(a => a.startsWith('--archive='));
  const archiveRoot = archiveArg ? path.resolve(archiveArg.slice(10)) : path.join(ROOT, 'data/aggregator-archive');
  if (!fs.existsSync(archiveRoot)) {
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
  if (args.includes('--delete')) {
    for (const h of hits) fs.unlinkSync(h.file);
    log(`deleted ${hits.length} file(s)`);
    return;
  }
  if (hits.length) process.exitCode = 1;
}

module.exports = { scanArchive };
if (require.main === module) main();
