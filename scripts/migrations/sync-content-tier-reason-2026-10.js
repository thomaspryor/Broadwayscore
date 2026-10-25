#!/usr/bin/env node
/**
 * BRO-3238 one-off backfill: rewrite a stale contentTierReason on every
 * review-text file whose contentTier is already right.
 *
 * Uses classifyTierWriteBack() (scripts/lib/content-tier-reason-sync.js), the
 * same computation rebuild-all-reviews.js now uses for its write-back, so the
 * first rebuild after this lands has nothing left to rewrite. Only the
 * contentTierReason field is written. Files whose TIER differs are left to
 * the rebuild's existing full write-back. Walks the same show dirs the
 * rebuild does (listShowDirs), so _superseded/ and other non-show dirs are
 * not touched.
 *
 * Writes the one field with a plain JSON write, NOT safeWriteReview: the
 * write guard also applies its own at-write corrections (duplicate clears,
 * temporal criticName guard, URL unwrapping), and on 2026-10-12 it changed a
 * second field on 76 of the 24,410 files. Those corrections are not this
 * backfill's to make. A file whose on-disk text is not the canonical
 * JSON.stringify(_, null, 2) form (with or without its trailing newline,
 * kept as found) is skipped and listed, so the
 * diff touches that one field and nothing else.
 *
 * Idempotent: an already-synced file is skipped, so an interrupted --apply is
 * resumed by running it again.
 *
 * Usage: node scripts/migrations/sync-content-tier-reason-2026-10.js [review-texts-dir] [--apply]
 */
'use strict';
const { isReviewTextFile } = require('../lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { classifyTierWriteBack } = require('../lib/content-tier-reason-sync');
const { listShowDirs } = require('../lib/list-show-dirs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..', 'data', 'review-texts'));

let scanned = 0, synced = 0, tierDiffers = 0, written = 0, failed = 0, unreadable = 0;
for (const dir of listShowDirs(ROOT)) {
  const full = path.join(ROOT, dir);
  for (const f of fs.readdirSync(full)) {
    if (!isReviewTextFile(f)) continue; // _blocklist.json is a sidecar
    const fp = path.join(full, f);
    let data, text;
    try { text = fs.readFileSync(fp, 'utf8'); data = JSON.parse(text); } catch { unreadable++; continue; }
    scanned++;
    const { tierResult, tierChanged, reasonOnlyChanged } = classifyTierWriteBack(data);
    if (tierChanged) { tierDiffers++; continue; }
    if (!reasonOnlyChanged) { synced++; continue; }
    // About 1 in 15 files has no trailing newline; keep each file's own ending.
    const eol = text.endsWith('\n') ? '\n' : '';
    if (JSON.stringify(data, null, 2) + eol !== text) {
      failed++; console.log(`[SKIP-NONCANONICAL] ${dir}/${f}`); continue;
    }
    if (APPLY) fs.writeFileSync(fp, JSON.stringify({ ...data, contentTierReason: tierResult.tierReason }, null, 2) + eol);
    written++;
  }
}
console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: scanned=${scanned} ${APPLY ? 'rewritten' : 'would-rewrite'}=${written} already-synced=${synced} tier-differs(left to rebuild)=${tierDiffers} skipped-noncanonical=${failed} unreadable=${unreadable}`);
if (failed) process.exitCode = 1;
