#!/usr/bin/env node
/**
 * BRO-8218: one-time (idempotent) backfill. _pending stubs settled by BRO-8202 as "same article as X
 * (url variant); stub carries originalScore the primary lacks" -> copy the stub's originalScore onto
 * the primary X (only when it has none) via safeWriteReview. Going forward replay-pending-bylines.js
 * does this merge itself. Usage: node scripts/backfill-stub-originalscore.js [--dry-run]
 */
const { hasHelpFlag } = require('./lib/cli-help');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage: node scripts/backfill-stub-originalscore.js [--dry-run]  (env REVIEW_TEXTS_DIR overrides the corpus path)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const dry = process.argv.includes('--dry-run');
const RE = /same article as (\S+\.json) .*carries originalScore the primary lacks/;
let merged = 0, already = 0, missing = 0, guardRejected = 0;
const pdir = path.join(ROOT, '_pending');
for (const ent of fs.readdirSync(pdir, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const showId = ent.name;
  const sd = path.join(pdir, showId);
  for (const f of fs.readdirSync(sd).filter((x) => x.endsWith('.json'))) {
    let stub; try { stub = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
    const m = RE.exec(String(stub.promoteSkippedReason || ''));
    if (!m || !stub.originalScore) continue;
    const pp = path.join(ROOT, showId, m[1]);
    if (!fs.existsSync(pp)) { missing++; console.log(`MISSING primary ${showId}/${m[1]}`); continue; }
    const prim = JSON.parse(fs.readFileSync(pp, 'utf8'));
    if (prim.originalScore) { already++; continue; }
    prim.originalScore = stub.originalScore;
    if (!dry) {
      const before = fs.readFileSync(pp, 'utf8');
      safeWriteReview(pp, prim);
      if (!JSON.parse(fs.readFileSync(pp, 'utf8')).originalScore) { // outlet publishes no critic rating: guard clears it (tier 1d); restore, don't merge
        fs.writeFileSync(pp, before); guardRejected++; console.log(`GUARD-REJECTED ${showId}/${m[1]} (outlet publishes no critic rating)`); continue;
      }
    }
    merged++;
    console.log(`${dry ? 'would merge' : 'merged'} "${stub.originalScore}" -> ${showId}/${m[1]}`);
  }
}
console.log(JSON.stringify({ merged, already, missing, guardRejected }));
