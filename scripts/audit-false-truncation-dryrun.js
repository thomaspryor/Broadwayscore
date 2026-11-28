#!/usr/bin/env node
/**
 * Dry-run only: which review-text files change content tier BECAUSE of the
 * trailer fix, i.e. which truncated files the next rebuild would upgrade to
 * complete (UK listing trailer, thefourthwalsh / one-minute-critic page
 * furniture, curly closing quote). The classifier runs twice per file, with
 * and without the fix (TRAILER_FIXES_DISABLED), so existing classifier drift
 * in the corpus is not blamed on it. Per outlet, with sample endings.
 *
 * READS the review-texts corpus and WRITES NOTHING to it. There is no --apply:
 * rebuild-all-reviews.js re-tiers every file on its own run, so landing the
 * classifier fix is the whole change.
 *
 * Usage:
 *   node scripts/audit-false-truncation-dryrun.js                  # table + 5 samples per outlet
 *   node scripts/audit-false-truncation-dryrun.js --samples=3
 *   node scripts/audit-false-truncation-dryrun.js --outlet=guardian
 *   node scripts/audit-false-truncation-dryrun.js --json=/tmp/out.json   # also write the summary (never inside the corpus)
 *   node scripts/audit-false-truncation-dryrun.js --dir=/path/to/review-texts
 *
 * Exit 1 if the fix would DOWNGRADE any file (complete to something lower):
 * that means it removed text it should not have.
 */

'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { diffTier, summarize } = require('./lib/false-truncation-diff');

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const dir = arg('dir', null) || resolveReviewTextsDir();
const sampleN = Math.max(0, parseInt(arg('samples', '5'), 10) || 0);
const onlyOutlet = arg('outlet', null);
const jsonOut = arg('json', null);

if (jsonOut) {
  // realpath both sides: in the main checkout data/review-texts is a symlink to the private repo.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(dir), path.join(real(path.dirname(path.resolve(jsonOut))), path.basename(jsonOut)));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.error('--json must point outside the review-texts corpus (this tool never writes there)');
    process.exit(2);
  }
}
if (!fs.existsSync(dir)) {
  console.error(`review-texts dir not found: ${dir}`);
  process.exit(2);
}

const records = [];
let scanned = 0;
for (const show of listShowDirs(dir, { silent: true, skipHolding: true })) {
  for (const f of fs.readdirSync(path.join(dir, show))) {
    if (!isReviewTextFile(f)) continue;
    let review;
    try { review = JSON.parse(fs.readFileSync(path.join(dir, show, f), 'utf8')); } catch { continue; }
    if (onlyOutlet && review.outletId !== onlyOutlet) continue;
    scanned++;
    const d = diffTier(review);
    if (d) records.push({ file: `${show}/${f}`, ...d });
  }
}

const s = summarize(records, sampleN);
console.log(`review-texts: ${dir}`);
console.log(`scanned ${scanned} files. Tier changes caused by the fix: ${s.total} (${s.upgrades} upgrades to complete, ${s.downgrades} downgrades). ${s.willChangeStored} of them differ from the stored tier and change on the next rebuild.\n`);
console.log('outlet'.padEnd(28) + 'upgrades to complete'.padStart(22) + 'of which truncated'.padStart(20) + 'downgrades'.padStart(12));
for (const r of s.byOutlet) {
  console.log(r.outletId.padEnd(28) + String(r.upgrades).padStart(22) + String(r.truncatedToComplete).padStart(20) + String(r.downgrades).padStart(12));
}
if (sampleN > 0) {
  for (const r of s.byOutlet) {
    if (!r.samples.length) continue;
    console.log(`\n== ${r.outletId} (${r.upgrades})`);
    for (const x of r.samples) console.log(`  ${x.file}\n    ...${JSON.stringify(x.tail)}`);
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(s, null, 2));
if (s.downgrades > 0) {
  console.error(`\nFAIL: ${s.downgrades} file(s) would downgrade from complete`);
  process.exit(1);
}
