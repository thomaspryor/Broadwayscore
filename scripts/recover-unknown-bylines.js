#!/usr/bin/env node
/**
 * recover-unknown-bylines.js
 *
 * Data backfill + repeatable guard for card #27. Finds review-text files whose
 * criticName is "Unknown" but that share a canonical URL with a sibling file
 * (same show + outlet) carrying the real byline, and copies the recovered name
 * onto the Unknown file. The rebuild then emits the correct critic instead of
 * "Unknown" (the sibling is frequently a wrongProduction/invalid dup that the
 * dedup excludes, so the scored copy is the Unknown one — see the 2026-07-14
 * Whoopi audit).
 *
 * Decision logic lives in scripts/lib/byline-recovery.js (unit-tested). This
 * driver only does I/O.
 *
 * Usage:
 *   node scripts/recover-unknown-bylines.js [--dir=PATH]          # dry run
 *   node scripts/recover-unknown-bylines.js [--dir=PATH] --apply  # write
 *
 * --dir defaults to <repo>/data/review-texts. Run once per copy (main working
 * tree + private broadway-review-texts) to keep both in sync.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { recoverBylinesForShow } = require('./lib/byline-recovery');
const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const dirArg = (process.argv.find((a) => a.startsWith('--dir=')) || '').split('=')[1];
const REVIEW_TEXTS_DIR = dirArg
  ? path.resolve(dirArg)
  : path.resolve(__dirname, '..', 'data', 'review-texts');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

if (!isDir(REVIEW_TEXTS_DIR)) {
  console.error(`review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
  process.exit(1);
}

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
  .filter((d) => !d.startsWith('_') && d !== 'aggregator-archive' && isDir(path.join(REVIEW_TEXTS_DIR, d)));

let scanned = 0;
let recovered = 0;
const changes = [];

for (const showId of showDirs) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }

  // Load once; keep the parsed JSON around by filename for the write pass.
  const records = [];
  const jsonByFile = new Map();
  for (const f of files) {
    const m = f.match(/^(.+?)--(.+)\.json$/);
    if (!m) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    records.push({ file: f, outletId: m[1], url: j.url, criticName: j.criticName, fullText: j.fullText });
    jsonByFile.set(f, j);
  }
  scanned += records.length;

  for (const { file, recoveredName } of recoverBylinesForShow(records)) {
    const j = jsonByFile.get(file);
    if (!j) continue;
    changes.push({ showId, file, from: j.criticName || '(empty)', to: recoveredName });
    recovered++;
    if (APPLY) {
      // Route through safeWriteReview (merge) so the temporal-byline guard can
      // veto/downgrade an attribution to a retired/deceased critic on an
      // old-dated review, and PROTECTED_FIELDS stay intact. Pass the existing
      // date alongside criticName — the guard only fires when newData carries a
      // publishDate/parsedDate (review-write-guard.js:355), so omitting it left
      // the guard inert.
      safeWriteReview(path.join(dir, file), {
        criticName: recoveredName,
        publishDate: j.publishDate,
        parsedDate: j.parsedDate,
        bylineRecoveredFrom: 'same-url-sibling', // provenance for audits
      }, { merge: true });
    }
  }
}

for (const c of changes) {
  console.log(`  ${c.showId}/${c.file}: "${c.from}" -> "${c.to}"`);
}
console.log(`\nDir: ${REVIEW_TEXTS_DIR}`);
console.log(`Scanned ${scanned} files across ${showDirs.length} shows.`);
console.log(`${APPLY ? 'Recovered' : 'Would recover'} ${recovered} Unknown byline(s).`);
if (!APPLY) console.log('(dry run — pass --apply to write changes)');
