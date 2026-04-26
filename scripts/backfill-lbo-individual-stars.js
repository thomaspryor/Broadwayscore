#!/usr/bin/env node
/**
 * Backfill aggregatorStars on lbo-individual review files where it's missing.
 *
 * Root cause: extractIndividualReviewFromLBO() previously hardcoded stars=null
 * (fixed 2026-04-26). Existing files ingested before the fix have no stars
 * field even though the source LBO page has a `class="bstarsN"` rating.
 *
 * Strategy:
 *   1. Walk data/review-texts/{show}/london-box-office--*.json
 *   2. For each lbo-individual file with a real LBO URL and no aggregatorStars,
 *      fetch the page and extract bstarsN.
 *   3. Write canonical aggregatorStars="X/5" + scoreSource="lbo-css-stars"
 *      + originalScoreNormalized.
 *   4. Do NOT set humanReviewScore — let rebuild handle scoring with the
 *      now-correct aggregator data.
 *
 * Use: node scripts/backfill-lbo-individual-stars.js [--dry-run] [--limit N]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const REVIEW_TEXTS_DIRS = [
  '/Users/tompryor/Broadwayscore/data/review-texts',
  '/Users/tompryor/broadway-review-texts',
];

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractStars(html) {
  const m = html && html.match(/class="[^"]*\bbstars(\d)\b[^"]*"/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 5) ? n : null;
}

async function main() {
  // Dedupe candidates by showId+filename across both dirs (private repo is
  // source of truth; main repo's data/review-texts is a synced copy).
  const candidates = new Map();
  for (const baseDir of REVIEW_TEXTS_DIRS) {
    if (!fs.existsSync(baseDir)) continue;
    for (const showDir of fs.readdirSync(baseDir)) {
      const fullDir = path.join(baseDir, showDir);
      let stat; try { stat = fs.statSync(fullDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const lboFiles = fs.readdirSync(fullDir).filter(f => f.startsWith('london-box-office'));
      for (const f of lboFiles) {
        const fp = path.join(fullDir, f);
        let d; try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
        if (d.source !== 'lbo-individual') continue;
        if (!d.url || !d.url.includes('londonboxoffice.co.uk')) continue;
        if (d.aggregatorStars) continue;
        const key = `${showDir}/${f}`;
        if (!candidates.has(key)) candidates.set(key, { showDir, file: f, url: d.url });
      }
    }
  }

  const list = Array.from(candidates.values()).slice(0, LIMIT);
  console.log(`Found ${candidates.size} lbo-individual files missing aggregatorStars (processing ${list.length})`);
  console.log();

  let updated = 0, noStars = 0, fetchFailed = 0;
  for (const { showDir, file, url } of list) {
    process.stdout.write(`${showDir}/${file} ... `);
    let html;
    try { html = await fetchHtml(url); } catch (e) { html = null; }
    if (!html) { console.log('FETCH FAILED'); fetchFailed++; continue; }
    const stars = extractStars(html);
    if (stars === null) { console.log('no bstarsN class'); noStars++; continue; }

    // Update both dirs (main repo + private repo)
    for (const baseDir of REVIEW_TEXTS_DIRS) {
      const fp = path.join(baseDir, showDir, file);
      if (!fs.existsSync(fp)) continue;
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      d.aggregatorStars = `${stars}/5`;
      d.scoreSource = 'lbo-css-stars';
      d.originalScoreNormalized = Math.round((stars / 5) * 100);
      d._notes = (d._notes || '') + `[2026-04-26 backfilled aggregatorStars=${stars}/5 from LBO page (extractor previously hardcoded null)] `;
      if (!DRY_RUN) fs.writeFileSync(fp, JSON.stringify(d, null, 2) + '\n');
    }
    console.log(`${stars}/5`);
    updated++;

    // Polite rate limit
    await new Promise(r => setTimeout(r, 800));
  }

  console.log();
  console.log(`Updated: ${updated}, No bstarsN: ${noStars}, Fetch failed: ${fetchFailed}`);
  if (DRY_RUN) console.log('(dry run — no files written)');
}

main().catch(e => { console.error(e); process.exit(1); });
