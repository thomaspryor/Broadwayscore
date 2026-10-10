#!/usr/bin/env node
/**
 * backfill-timeout-london-mislabels.js — task #1533.
 *
 * Corrects review-text files where outletId='timeout' (Time Out New York,
 * tier 1) but the url field is actually on timeout.com/london or
 * timeout.co.uk/london (Time Out London, tier 2). These predate task #1529's
 * write-time guard fix and never self-healed because rebuild-all-reviews.js's
 * own timeout->timeout-london auto-correct (line ~2978) sits AFTER the
 * wrongProduction/wrongShow early-return checks in the same loop — files
 * flagged wrongProduction/wrongShow (the common case here, since a
 * US-labeled 'timeout' review on a UK show trips the cross-market guard)
 * never reach the auto-correct at all.
 *
 * Only fixes outletId/outlet (and, when the existing auto-correct's own
 * clearing condition matches, the wrongProduction note it caused) — it does
 * NOT rename files. Renaming/merging duplicates is left to
 * rebuild-all-reviews.js's existing "Stale outlet-mismatch cleanup" pass,
 * which already merges/renames whenever a file's outlet prefix disagrees
 * with its JSON outletId — this backfill just makes that disagreement true
 * so the next CI rebuild resolves it with its own battle-tested merge logic.
 *
 * Usage:
 *   node scripts/backfill-timeout-london-mislabels.js [--dir=path] [--execute]
 *   (default: dry run, prints planned changes, writes nothing)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const dirArg = args.find(a => a.startsWith('--dir='));
const reviewTextsDir = dirArg
  ? dirArg.slice('--dir='.length)
  : path.join(__dirname, '..', 'data', 'review-texts');

function isLondonUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return u.includes('timeout.com/london') || u.includes('timeout.co.uk/london');
}

const showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

const planned = [];
let alreadyCorrect = 0;

for (const showId of showDirs) {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.startsWith('timeout--') && f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(showDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`  [skip] ${showId}/${file}: parse error — ${e.message}`);
      continue;
    }
    if (data.outletId !== 'timeout') continue; // already timeout-london or something else
    if (!isLondonUrl(data.url)) continue; // real NY url, or no url — leave alone

    const willClearWrongProduction = !!(
      data.wrongProduction &&
      data.wrongProductionNote &&
      data.wrongProductionNote.includes('US outlet "timeout"')
    );

    planned.push({
      showId,
      file,
      filePath,
      url: data.url,
      wrongProduction: !!data.wrongProduction,
      wrongShow: !!data.wrongShow,
      duplicateOf: data.duplicateOf || null,
      contentTier: data.contentTier || null,
      willClearWrongProduction,
    });
  }
}

console.log(`Scanned ${showDirs.length} show dirs under ${reviewTextsDir}`);
console.log(`Planned outletId corrections (timeout -> timeout-london): ${planned.length}`);
console.log('');
for (const p of planned) {
  const flags = [
    p.wrongProduction ? 'wrongProduction' : null,
    p.wrongShow ? 'wrongShow' : null,
    p.duplicateOf ? `duplicateOf=${p.duplicateOf}` : null,
    p.contentTier ? `contentTier=${p.contentTier}` : null,
    p.willClearWrongProduction ? 'CLEARS wrongProduction note' : null,
  ].filter(Boolean).join(', ');
  console.log(`  ${p.showId}/${p.file}${flags ? `  [${flags}]` : ''}`);
}

const scoreable = planned.filter(p =>
  !p.wrongProduction && !p.wrongShow && !p.duplicateOf &&
  p.contentTier !== 'stub' && p.contentTier !== 'invalid'
);
console.log('');
console.log(`Currently live-scoreable (no exclusion flags, non-stub/invalid): ${scoreable.length}`);
if (scoreable.length) {
  for (const p of scoreable) console.log(`    SCOREABLE: ${p.showId}/${p.file}`);
}

if (!execute) {
  console.log('');
  console.log('Dry run only — no files written. Re-run with --execute to apply.');
  process.exit(0);
}

let written = 0;
for (const p of planned) {
  const data = JSON.parse(fs.readFileSync(p.filePath, 'utf8'));
  data.outletId = 'timeout-london';
  data.outlet = 'Time Out London';
  if (p.willClearWrongProduction) {
    delete data.wrongProduction;
    delete data.wrongProductionNote;
  }
  fs.writeFileSync(p.filePath, JSON.stringify(data, null, 2) + '\n');
  written++;
}
console.log(`Wrote outletId corrections to ${written} files.`);
console.log('Next: commit + push data/review-texts, then let CI rebuild rename/merge via its existing stale-outlet-mismatch pass.');
