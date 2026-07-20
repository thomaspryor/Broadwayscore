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

// SAFETY BLOCK (2026-07-14 incident): applying this recovery is DISABLED.
// Setting an outlet--unknown.json criticName to match a same-URL sibling turns
// the pair into a same-name+same-URL duplicate; the rebuild's rename/dedup
// helper then DELETES the scored --unknown twin, and when the surviving sibling
// is flagged wrongProduction/invalid the review is dropped entirely (34 scored
// reviews lost, reverted). The decision library (scripts/lib/byline-recovery.js)
// is sound and unit-tested; the WRITE mechanism is not. A rename-safe redesign
// is carded (Notion 39e637c5-416f-81bc) — clear the flag on the correctly-bylined
// sibling, or fix the rebuild dedup precedence, instead of naming the twin.
// Dry-run (report-only) stays available. Override only inside that redesign.
if (APPLY && !process.argv.includes('--i-have-redesigned-the-rename-safe-write')) {
  console.error([
    'REFUSING --apply: this write mechanism drops scored reviews (2026-07-14 incident).',
    'Naming outlet--unknown.json to match a same-URL sibling makes the rebuild',
    'rename/dedup DELETE the scored twin. See the header + Notion 39e637c5-416f-81bc.',
    'Dry-run (omit --apply) still reports candidates.',
  ].join('\n'));
  process.exit(2);
}
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

const RECOVERED_MARK = 'same-url-sibling';
const RESET_MARK = 'reset-unsafe-flagged-sibling';
const isFlagged = (j) => !!(j.wrongProduction || j.wrongShow || j.isNonReview || j.contentTier === 'invalid');

let scanned = 0;
let recovered = 0;
let reset = 0;
const changes = [];

for (const showId of showDirs) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }

  // Load once; keep the parsed JSON around by filename for the write pass.
  const jsonByFile = new Map();
  const records = [];
  for (const f of files) {
    const m = f.match(/^(.+?)--(.+)\.json$/);
    if (!m) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    jsonByFile.set(f, j);
    // Normalize for the recompute: a previously-recovered file is treated as
    // Unknown, so the corrected gates decide afresh whether it still qualifies.
    const wasRecovered = j.bylineRecoveredFrom === RECOVERED_MARK;
    records.push({
      file: f,
      outletId: m[1],
      url: j.url,
      criticName: wasRecovered ? 'Unknown' : j.criticName,
      fullText: j.fullText,
      flagged: isFlagged(j),
      _wasRecovered: wasRecovered,
    });
  }
  scanned += records.length;

  const toRecover = new Map(recoverBylinesForShow(records).map((x) => [x.file, x.recoveredName]));

  for (const r of records) {
    const j = jsonByFile.get(r.file);
    if (toRecover.has(r.file)) {
      const name = toRecover.get(r.file);
      if (j.criticName === name && j.bylineRecoveredFrom === RECOVERED_MARK) continue; // already correct
      changes.push({ showId, file: r.file, from: j.criticName || '(empty)', to: name });
      recovered++;
      if (APPLY) {
        safeWriteReview(path.join(dir, r.file), {
          criticName: name,
          publishDate: j.publishDate,
          parsedDate: j.parsedDate,
          bylineRecoveredFrom: RECOVERED_MARK, // provenance for audits
        }, { merge: true });
      }
    } else if (r._wasRecovered) {
      // Unwind a prior recovery the corrected gates now reject (its same-URL
      // sibling is flagged → naming it merge-drops the scored review). Restore
      // 'Unknown' so the scored review survives the rebuild.
      changes.push({ showId, file: r.file, from: j.criticName || '(empty)', to: 'Unknown (reset)' });
      reset++;
      if (APPLY) {
        safeWriteReview(path.join(dir, r.file), {
          criticName: 'Unknown',
          bylineRecoveredFrom: RESET_MARK,
        }, { merge: true });
      }
    }
  }
}

for (const c of changes) {
  console.log(`  ${c.showId}/${c.file}: "${c.from}" -> "${c.to}"`);
}
console.log(`\nDir: ${REVIEW_TEXTS_DIR}`);
console.log(`Scanned ${scanned} files across ${showDirs.length} shows.`);
console.log(`${APPLY ? 'Recovered' : 'Would recover'} ${recovered} byline(s); ${APPLY ? 'reset' : 'would reset'} ${reset} unsafe prior recovery(ies).`);
if (!APPLY) console.log('(dry run — pass --apply to write changes)');
