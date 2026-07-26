#!/usr/bin/env node
/**
 * Backfill unknown critics using archive.org HTML.
 *
 * For review files with criticName="Unknown" and an archiveOrgUrl,
 * fetches the archived HTML and extracts the author byline.
 * Much more reliable than fetching original URLs (no paywalls, no TLS issues).
 *
 * Usage:
 *   node scripts/backfill-critics-archive-org.js              # Run for real
 *   node scripts/backfill-critics-archive-org.js --dry-run    # Preview only
 *   node scripts/backfill-critics-archive-org.js --limit=50   # Process max 50
 */

const fs = require('fs');
const path = require('path');
const { extractAuthorFromHtml } = require('./lib/content-quality');
const { normalizeCritic, normalizeOutlet, generateReviewFilename } = require('./lib/review-normalization');
const { mergeUniqueReviewFields } = require('./lib/merge-review-fields');
const { listShowDirs } = require('./lib/list-show-dirs');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-critics-archive-org.js — Backfill unknown critics using archive.org HTML.

Usage:
  node scripts/backfill-critics-archive-org.js [options]
  node scripts/backfill-critics-archive-org.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 0;

const REJECT_NAMES = new Set([
  'condé nast', 'conde nast', 'the associated press', 'associated press',
  'ap', 'reuters', 'staff', 'staff writer', 'editorial', 'editor',
  'admin', 'administrator', 'contributor', 'guest', 'anonymous',
  'broadway world', 'broadwayworld', 'broadway.com', 'playbill',
  'the new yorker', 'the guardian', 'variety', 'the wrap',
  'the hollywood reporter', 'the daily beast', 'entertainment weekly',
  'ny1', 'time out', 'timeout', 'new york times', 'the new york times',
  'bww news desk', 'broadway news desk', 'news desk',
  'financial times', 'the stage', 'the playlist', 'the reviews hub',
]);

function isRejectName(name) {
  if (!name || name.length < 4) return true;
  if (REJECT_NAMES.has(name.toLowerCase())) return true;
  if (!name.includes(' ')) return true;
  if (name.includes('http') || name.includes('.com')) return true;
  if (name === name.toUpperCase() && name.length > 5) return true;
  if (/^(reviewed by|written by|by |photo |image |credit)/i.test(name)) return true;
  if (/^(staff|desk|team|wire|bureau|press|agency|service)/i.test(name)) return true;
  if (/^(updated|originally|published|posted|modified|created)\s/i.test(name)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s/i.test(name)) return true;
  return false;
}

const reviewsDir = path.join(__dirname, '..', 'data', 'review-texts');

// Scan for candidates
const candidates = [];
for (const sid of listShowDirs(reviewsDir)) {
  const sDir = path.join(reviewsDir, sid);
  try {
    if (fs.lstatSync(sDir).isSymbolicLink()) continue;
    if (!fs.statSync(sDir).isDirectory()) continue;
  } catch { continue; }
  for (const f of fs.readdirSync(sDir).filter(x => x.endsWith('.json') && x.includes('--unknown'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8'));
      if (d.criticName && d.criticName !== 'Unknown') continue;
      if (d.archiveOrgUrl) {
        candidates.push({ sid, file: f, filePath: path.join(sDir, f), archiveUrl: d.archiveOrgUrl, data: d });
      }
    } catch {}
  }
}

const toProcess = limit ? candidates.slice(0, limit) : candidates;
console.log(`Found ${candidates.length} candidates with archive.org URLs, processing ${toProcess.length}`);
if (dryRun) console.log('DRY RUN — no files will be modified');

async function processAll() {
  let resolved = 0, renamed = 0, dupes = 0, rejected = 0, failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const c = toProcess[i];
    try {
      const resp = await fetch(c.archiveUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { failed++; continue; }
      const html = await resp.text();
      const author = extractAuthorFromHtml(html);

      if (!author || isRejectName(author)) {
        if (author) rejected++;
        else failed++;
        continue;
      }

      // Update critic name
      c.data.criticName = author;
      c.data.criticEnrichedFrom = 'archive-org-html';

      const outletId = normalizeOutlet(c.data.outletId || c.data.outlet);
      const newFilename = generateReviewFilename(outletId, author);
      const newPath = path.join(reviewsDir, c.sid, newFilename);

      if (!dryRun) {
        if (c.file !== newFilename) {
          if (fs.existsSync(newPath)) {
            // Merge unique fields from --unknown into named file, then delete.
            // Guarded: a flagged source never folds into the named sibling
            // (merge-review-fields.js, Notion 39b637c5-416f-815e) — leave it.
            const existing = JSON.parse(fs.readFileSync(newPath, 'utf8'));
            const mergeResult = mergeUniqueReviewFields(existing, c.data);
            if (mergeResult.action === 'skip-flagged-source') continue;
            if (mergeResult.changed) {
              fs.writeFileSync(newPath, JSON.stringify(existing, null, 2) + '\n');
            }
            fs.unlinkSync(c.filePath);
            dupes++;
          } else {
            fs.writeFileSync(newPath, JSON.stringify(c.data, null, 2) + '\n');
            fs.unlinkSync(c.filePath);
            renamed++;
          }
        } else {
          fs.writeFileSync(c.filePath, JSON.stringify(c.data, null, 2) + '\n');
        }
      }

      resolved++;
      if (resolved <= 20 || resolved % 50 === 0) {
        console.log(`  [${i + 1}/${toProcess.length}] ${c.sid}/${c.file} → ${author}`);
      }

      // Rate limit: ~3 req/sec for archive.org
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      failed++;
    }
  }

  console.log(`\n=== Results${dryRun ? ' (DRY RUN)' : ''} ===`);
  console.log(`Resolved: ${resolved}`);
  console.log(`Renamed: ${renamed}`);
  console.log(`Merged (dupe deleted): ${dupes}`);
  console.log(`Rejected (outlet/bad names): ${rejected}`);
  console.log(`Failed (404/error/no author): ${failed}`);
  if (toProcess.length > 0) {
    console.log(`Success rate: ${(resolved / toProcess.length * 100).toFixed(1)}%`);
  }
}

processAll().catch(console.error);
