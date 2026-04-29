#!/usr/bin/env node
/**
 * replay-pending-bylines.js
 *
 * Files in data/review-texts/_pending/{showId}/{outlet}--{hash}.json end up there
 * when discovery returns a URL but no defaultCritic is in outlet-registry and the
 * byline wasn't detectable at write time. _pending is a HARD SINK —
 * collect-review-texts.js does NOT scan it (verified 2026-04-29).
 *
 * This replay script:
 *   1. Walks _pending/{showId}/ for each opera show (or all shows with --all)
 *   2. Fetches the URL via fetchPage
 *   3. Extracts byline via existing extractAuthorFromHtml
 *   4. If byline found: rename file to {outlet}--{critic-slug}.json, move to
 *      data/review-texts/{showId}/, remove from _pending
 *   5. If not found: leave in _pending, log
 *
 * Usage:
 *   node scripts/replay-pending-bylines.js --show=eugene-onegin-off-broadway-2026
 *   node scripts/replay-pending-bylines.js --shows=show1,show2
 *   node scripts/replay-pending-bylines.js --all-opera
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');
const { extractAuthorFromHtml, extractHighConfidenceAuthor } = require('./lib/content-quality');
const { normalizeCritic } = require('./lib/review-normalization');

const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const allOpera = args.includes('--all-opera');
const dryRun = args.includes('--dry-run');

const PENDING_ROOT = path.join(__dirname, '../data/review-texts/_pending');
const REVIEW_TEXTS_ROOT = path.join(__dirname, '../data/review-texts');

function listOperaShowIds() {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return (data.shows || data).filter(s => s.type === 'opera').map(s => s.id);
}

function showIds() {
  if (showArg) return [showArg];
  if (showsArg) return showsArg.split(',').map(s => s.trim()).filter(Boolean);
  if (allOpera) return listOperaShowIds();
  console.error('Usage: --show=ID | --shows=ID1,ID2 | --all-opera');
  process.exit(1);
}

async function processShow(showId) {
  const pendingDir = path.join(PENDING_ROOT, showId);
  if (!fs.existsSync(pendingDir)) {
    console.log(`[${showId}] no _pending dir`);
    return { promoted: 0, kept: 0 };
  }
  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  console.log(`[${showId}] ${files.length} pending files to inspect`);

  let promoted = 0, kept = 0;
  for (const file of files) {
    const filepath = path.join(pendingDir, file);
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const url = data.url;
    if (!url) {
      console.log(`  [${file}] no URL — skip`);
      kept++;
      continue;
    }

    let byline = null;
    let html = null;
    try {
      const result = await fetchPage(url);
      html = result?.content;
      if (!html) {
        console.log(`  [${file}] fetch returned no content — keep`);
        kept++;
        continue;
      }
      // Try the high-confidence HTML extractors first
      byline = extractHighConfidenceAuthor(html) || extractAuthorFromHtml(html, '', { outletId: data.outletId });
    } catch (e) {
      console.log(`  [${file}] fetch failed: ${e.message.slice(0, 80)} — keep`);
      kept++;
      continue;
    }

    if (!byline || byline === 'Unknown') {
      console.log(`  [${file}] no byline detected — keep in pending`);
      kept++;
      continue;
    }

    // Promote: rename to {outlet}--{critic-slug}.json + move to review-texts/{showId}/
    const criticSlug = normalizeCritic(byline);
    const newFilename = `${data.outletId}--${criticSlug}.json`;
    const newPath = path.join(REVIEW_TEXTS_ROOT, showId, newFilename);

    // Don't overwrite an existing real file
    if (fs.existsSync(newPath)) {
      console.log(`  [${file}] would-be target ${newFilename} already exists — keep pending`);
      kept++;
      continue;
    }

    data.criticName = byline;
    data.bylineSource = 'replay-pending-bylines';
    data.bylineExtractedAt = new Date().toISOString();

    if (dryRun) {
      console.log(`  [${file}] DRY → would promote to ${newFilename} (byline: ${byline})`);
      promoted++;
      continue;
    }

    if (!fs.existsSync(path.dirname(newPath))) fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
    fs.unlinkSync(filepath);
    console.log(`  [${file}] PROMOTED → ${newFilename} (byline: ${byline})`);
    promoted++;
  }

  return { promoted, kept };
}

(async () => {
  const ids = showIds();
  console.log(`Processing ${ids.length} show(s)${dryRun ? ' [DRY RUN]' : ''}\n`);

  let totalPromoted = 0, totalKept = 0;
  for (const id of ids) {
    const { promoted, kept } = await processShow(id);
    totalPromoted += promoted;
    totalKept += kept;
  }

  console.log(`\n━━━ Replay complete ━━━`);
  console.log(`Promoted: ${totalPromoted}`);
  console.log(`Kept in _pending: ${totalKept}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
