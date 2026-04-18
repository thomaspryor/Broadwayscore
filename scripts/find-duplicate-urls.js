#!/usr/bin/env node
/**
 * Find duplicate URLs in review-texts directories.
 *
 * Scans all show directories under data/review-texts/ and reports any two files
 * in the same show directory that share an identical URL (where neither has
 * duplicateOf set — known duplicates are expected).
 *
 * Usage:
 *   node scripts/find-duplicate-urls.js [--show=SHOW_ID] [--verbose]
 *
 * Exit code: 0 if no undeclared duplicates found, 1 if duplicates exist.
 */

const fs = require('fs');
const path = require('path');

// Support running from a worktree where data/ isn't present
const _candidates = [
  path.join(__dirname, '..', 'data', 'review-texts'),
  '/Users/tompryor/Broadwayscore/data/review-texts',
  path.join(process.env.HOME || '', 'Broadwayscore', 'data', 'review-texts'),
];
const REVIEW_TEXTS_DIR = _candidates.find(d => fs.existsSync(d)) || _candidates[0];

const args = process.argv.slice(2);
const filterShow = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;
const verbose = args.includes('--verbose');

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    // Strip utm_* and fbclid tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid/.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

let pairsFound = 0;
let showsScanned = 0;

let showDirs;
try {
  showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    if (d.startsWith('_')) return false; // skip _pending, _archive etc.
    if (filterShow && d !== filterShow) return false;
    const full = path.join(REVIEW_TEXTS_DIR, d);
    return fs.statSync(full).isDirectory();
  });
} catch (e) {
  console.error(`Cannot read ${REVIEW_TEXTS_DIR}: ${e.message}`);
  process.exit(1);
}

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f =>
    f.endsWith('.json') && f !== 'failed-fetches.json'
  );

  showsScanned++;

  // Build url → [filename] map
  const urlMap = new Map();
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
    } catch { continue; }

    if (!data.url) continue;
    const norm = normalizeUrl(data.url);
    if (!norm) continue;
    if (!urlMap.has(norm)) urlMap.set(norm, []);
    urlMap.get(norm).push({ file: f, data });
  }

  // Report pairs where neither file has declared the duplicate relationship
  for (const [url, entries] of urlMap) {
    if (entries.length < 2) continue;
    // Filter to undeclared duplicates
    const undeclared = entries.filter(e => !e.data.duplicateOf);
    if (undeclared.length < 2) continue;

    pairsFound++;
    const names = undeclared.map(e => e.file).join(', ');
    console.log(`\n[${showId}] ${undeclared.length} files share URL:`);
    console.log(`  URL: ${url}`);
    console.log(`  Files: ${names}`);
    if (verbose) {
      for (const e of undeclared) {
        const fields = ['criticName', 'outlet', 'publishDate', 'source'].map(k => `${k}=${JSON.stringify(e.data[k])}`).join(', ');
        console.log(`    ${e.file}: ${fields}`);
      }
    }
  }
}

console.log(`\nScanned ${showsScanned} shows — ${pairsFound === 0 ? '✅ No undeclared duplicate URLs found' : `⚠️  ${pairsFound} duplicate URL pair(s) found`}`);
process.exit(pairsFound > 0 ? 1 : 0);
