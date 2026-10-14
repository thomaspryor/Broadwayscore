#!/usr/bin/env node
'use strict';
/**
 * Flag named review files for rescoring after BRO-5294 taught the scorer to
 * read only the target show's section of a multi-review (WSJ) column.
 *
 *   node scripts/flag-multishow-column-rescore.js --file=<show>/<file>.json[,...] [--dry-run]
 *
 * Then: llm-ensemble-score.yml with needs_rescore=true and
 * rescore_reason=multi-show (any prefix works; spaces are kept since BRO-5254).
 */
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { flagMultiShowRescore } = require('./lib/multishow-rescore-flag');
const { parseFileSpecs } = require('./lib/reverify-file-mode');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/flag-multishow-column-rescore.js --file=<show>/<file>.json[,...] [--dry-run]');
  process.exit(0);
}
const fileArg = args.find((a) => a.startsWith('--file='));
if (!fileArg) { console.error('--file=<show>/<file>.json[,...] is required'); process.exit(1); }
let specs;
try { specs = parseFileSpecs(fileArg.slice('--file='.length)); } catch (e) { console.error(e.message); process.exit(1); }
const dryRun = args.includes('--dry-run');
const root = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

let flagged = 0;
for (const { showId, file } of specs) {
  const p = path.join(root, showId, file);
  if (!fs.existsSync(p)) { console.log(`  MISSING ${showId}/${file}`); continue; }
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const r = flagMultiShowRescore(data);
  console.log(`  ${r.ok ? 'FLAGGED' : 'SKIP   '} ${showId}/${file}: ${r.reason}`);
  if (r.ok) { flagged++; if (!dryRun) safeWriteReview(p, data); }
}
console.log(`${flagged} of ${specs.length} flagged${dryRun ? ' (dry run)' : ''}`);
