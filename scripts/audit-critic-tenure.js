#!/usr/bin/env node
/**
 * Read-only count of critic/outlet tenure flags (BRO-5222).
 *
 * Same scan and the same findTenureFlags() as audit-critic-outlets.js, without
 * that script's registry/audit writes, so a card can use it as its acceptance
 * command. Rows listed with evidence in scripts/config/critic-tenure-reviewed.json
 * count as reviewed. Prints one line per unresolved flag and the counts.
 *
 * Usage:
 *   node scripts/audit-critic-tenure.js            # report, exit 0
 *   node scripts/audit-critic-tenure.js --max=N    # exit 1 when unresolved > N
 */
'use strict';

const { scanReviewTexts } = require('./lib/critic-review-scan');
const { findTenureFlags, applyReviewedTenureFlags, tenureFlagKey } = require('./lib/critic-tenure');
const { reviewed } = require('./config/critic-tenure-reviewed.json');

function main() {
  const maxArg = process.argv.slice(2).find(a => a.startsWith('--max='));
  const maxRaw = maxArg ? maxArg.slice('--max='.length) : null;
  const max = maxRaw !== null ? Number(maxRaw) : null;
  if (maxArg && !/^\d+$/.test(maxRaw)) {
    console.error(`Invalid ${maxArg}`);
    process.exit(2);
  }

  const { critics, totalFiles } = scanReviewTexts();
  // An empty or unsynced corpus would report 0 flags and pass --max (the
  // same guard audit-critic-outlets.js runs after this scan, BRO-5261).
  if (!totalFiles) {
    console.error('No review-text files scanned: data/review-texts is empty or not synced.');
    process.exit(2);
  }
  const r = applyReviewedTenureFlags(findTenureFlags(critics), reviewed);
  const flags = r.unresolved;
  for (const f of flags) {
    const detail = f.kind === 'outside_tenure'
      ? `${f.year} outside ${f.tenure.first}-${f.tenure.last}`
      : `no verified row at this outlet`;
    console.log(`  [${f.kind}] ${f.critic} at ${f.outlet} for ${f.showId}: ${detail}  key=${tenureFlagKey(f)}`);
  }
  for (const e of r.stale) console.log(`  [stale reviewed entry] ${e.key}`);
  console.log(`Tenure flags: ${flags.length} unresolved, ${r.reviewed.length} reviewed, ${r.stale.length} stale, ${r.invalid.length} invalid entries (${totalFiles} files scanned)`);
  if (max !== null && flags.length > max) {
    console.log(`FAIL: ${flags.length} > --max=${max}`);
    process.exit(1);
  }
}

main();
