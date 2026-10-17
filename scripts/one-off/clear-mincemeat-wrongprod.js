#!/usr/bin/env node
/**
 * One-off: Clear wrongProduction flags on Operation Mincemeat WE reviews
 * that were incorrectly flagged due to wrong opening date in shows.json.
 *
 * The opening date was listed as 2024-03-29 but should be 2023-05-09.
 * Reviews from the WE press night (May 2023) were flagged as wrongProduction
 * because they appeared to be >90 days before the (incorrect) opening date.
 *
 * This clears wrongProduction on reviews where:
 * - wrongProductionNote starts with "Pre-opening guard" (date-based flag)
 * - Review date is on or after 2023-03-29 (WE previews start)
 * - Review date is before 2024-12-31 (to avoid clearing Broadway 2025 reviews)
 *
 * Reviews flagged for other reasons (e.g., "Same URL correctly belongs in...")
 * are left untouched.
 */

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../../data/review-texts/operation-mincemeat-west-end-2024');
if (!fs.existsSync(dir)) {
  console.error('Directory not found:', dir);
  process.exit(1);
}

const WE_PREVIEWS = new Date('2023-03-29');
const WE_CUTOFF = new Date('2024-12-31'); // Don't clear Broadway 2025 reviews

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let cleared = 0, kept = 0, skipped = 0;

for (const f of files) {
  const filepath = path.join(dir, f);
  const d = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  if (!d.wrongProduction) {
    skipped++;
    continue;
  }

  // Only clear date-based flags (not cross-production URL flags)
  const isDateFlag = d.wrongProductionNote &&
    (d.wrongProductionNote.startsWith('Pre-opening guard') ||
     d.wrongProductionNote.startsWith('Date guard') ||
     d.wrongProductionNote.startsWith('Auto-flagged'));
  if (!isDateFlag) {
    console.log(`  KEEP ${f}: ${d.wrongProductionNote?.slice(0, 60)}`);
    kept++;
    continue;
  }

  // Parse the review date
  const { parseDate } = require('../lib/date-utils');
  let reviewDate = parseDate(d.publishDate);

  if (reviewDate && reviewDate >= WE_PREVIEWS && reviewDate <= WE_CUTOFF) {
    delete d.wrongProduction;
    delete d.wrongProductionNote;
    d.wrongProductionManualClear = 'Cleared: shows.json had wrong openingDate (2024-03-29→2023-05-09)';
    // Also clear invalid contentTier that was set alongside wrongProduction
    if (d.contentTier === 'invalid') {
      d.contentTier = d.fullText ? 'complete' : (d.dtliExcerpt || d.showScoreExcerpt ? 'excerpt' : 'stub');
    }
    fs.writeFileSync(filepath, JSON.stringify(d, null, 2) + '\n');
    console.log(`  CLEARED ${f} (${d.publishDate})`);
    cleared++;
  } else {
    console.log(`  KEEP ${f}: date ${d.publishDate} outside WE range`);
    kept++;
  }
}

console.log(`\nDone: ${cleared} cleared, ${kept} kept wrongProd, ${skipped} already OK`);
