#!/usr/bin/env node
/**
 * Re-audit garbage content — reclaim reviews incorrectly classified as garbage.
 *
 * Examines all review-text files with garbageFullText but no fullText.
 * Applies improved garbage detection (position-aware) and cleanText().
 * Validates content is about the right show before promoting.
 *
 * Usage:
 *   node scripts/reaudit-garbage-content.js              # Dry run (report only)
 *   node scripts/reaudit-garbage-content.js --apply       # Apply changes to source files
 */

const fs = require('fs');
const path = require('path');
const { isGarbageContent, validateShowMentioned, classifyContentTier } = require('./lib/content-quality');
const { cleanText } = require('./lib/text-cleaning');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

// Load shows.json for title lookup
const showsPath = path.join(__dirname, '../data/shows.json');
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const shows = showsData.shows || showsData;
const showById = {};
for (const s of shows) {
  showById[s.id] = s;
}

// Walk review-texts directory
function walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) results.push(...walkDir(full));
    else if (e.name.endsWith('.json') && e.name !== 'failed-fetches.json') results.push(full);
  }
  return results;
}

const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const allFiles = walkDir(reviewTextsDir);

const stats = {
  totalGarbageOnly: 0,
  reclaimable: 0,
  stillGarbage: 0,
  wrongShow: 0,
  tooShort: 0,
  errorPage: 0,
  applied: 0,
  byOutlet: {},
  byReason: {},
  reclaimedFiles: [],
  failedFiles: [],
};

console.log(`Scanning ${allFiles.length} review-text files...`);

for (const f of allFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    continue;
  }

  // Only process files with garbageFullText and no fullText
  if (!data.garbageFullText || (data.fullText && data.fullText.length > 100)) continue;

  stats.totalGarbageOnly++;
  const outlet = data.outlet || data.outletId || 'unknown';
  stats.byOutlet[outlet] = (stats.byOutlet[outlet] || 0) + 1;

  const showId = f.split('/').slice(-2, -1)[0];
  const show = showById[showId];
  const showTitle = show ? show.title : showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const origReason = data.garbageReason || 'unknown';
  const relFile = f.replace(reviewTextsDir + '/', '');

  // Guard: respect manually-set wrong-production and wrong-outlet flags
  if (/wrong production/i.test(origReason) || /wrong outlet/i.test(origReason)) {
    stats.byReason['manual-flag-preserved'] = (stats.byReason['manual-flag-preserved'] || 0) + 1;
    stats.failedFiles.push({ file: relFile, reason: 'manual-flag: ' + origReason, outlet });
    stats.stillGarbage++;
    continue;
  }

  // Guard: skip full-page dumps (>20K chars is almost certainly a full page with review buried)
  if (data.garbageFullText.length > 20000) {
    stats.byReason['page-dump-too-large'] = (stats.byReason['page-dump-too-large'] || 0) + 1;
    stats.failedFiles.push({ file: relFile, reason: 'page-dump (' + data.garbageFullText.length + ' chars)', outlet });
    stats.stillGarbage++;
    continue;
  }

  // Step 1: Re-check with improved garbage detector
  const garbageCheck = isGarbageContent(data.garbageFullText);

  // Step 2: If still garbage, check if it's an error page (never recover)
  if (garbageCheck.isGarbage) {
    const reason = garbageCheck.reason || '';
    if (/error|404|page not found/i.test(reason)) {
      stats.errorPage++;
    }
    stats.stillGarbage++;
    const cat = reason.substring(0, 50);
    stats.byReason[cat] = (stats.byReason[cat] || 0) + 1;
    if (VERBOSE) console.log(`  STILL GARBAGE: ${f.replace(reviewTextsDir + '/', '')} — ${reason}`);
    stats.failedFiles.push({ file: f.replace(reviewTextsDir + '/', ''), reason: cat, outlet });
    continue;
  }

  // Step 3: Clean the text
  const cleaned = cleanText(data.garbageFullText);
  if (!cleaned || cleaned.length < 200) {
    stats.tooShort++;
    stats.byReason['cleaned-too-short'] = (stats.byReason['cleaned-too-short'] || 0) + 1;
    stats.failedFiles.push({ file: f.replace(reviewTextsDir + '/', ''), reason: 'cleaned-too-short', outlet });
    continue;
  }

  // Step 4: Validate content is about the right show
  // Strict: show must be mentioned in the OPENING of the text (first 40%), not just anywhere.
  // A review about a show will always name it in the opening. Sidebar/footer mentions don't count.
  const showCheck = validateShowMentioned(cleaned, showTitle, showId);
  if (!showCheck.valid) {
    stats.wrongShow++;
    stats.byReason['wrong-show'] = (stats.byReason['wrong-show'] || 0) + 1;
    if (VERBOSE) console.log(`  WRONG SHOW: ${relFile} — ${showCheck.reason}`);
    stats.failedFiles.push({ file: relFile, reason: 'wrong-show: ' + showCheck.reason, outlet });
    continue;
  }

  // Extra guard: verify show mention is in the FRONT of the text, not buried in sidebar
  const frontText = cleaned.substring(0, Math.min(cleaned.length * 0.4, 3000)).toLowerCase();
  const titleLower = showTitle.toLowerCase();
  const titleInFront = frontText.includes(titleLower) ||
    frontText.includes(titleLower.replace(/^the\s+/, ''));
  // Also check show ID words (for shows with common-word titles that might not match above)
  const idBase = showId.replace(/-\d{4}$/, '');
  const idWords = idBase.split('-').filter(w => w.length > 3 && !['the', 'and', 'for', 'with'].includes(w));
  const idWordsInFront = idWords.length >= 2
    ? idWords.filter(w => frontText.includes(w)).length >= 2
    : idWords.length === 1 && idWords[0].length > 5 && frontText.includes(idWords[0]);

  if (!titleInFront && !idWordsInFront) {
    stats.wrongShow++;
    stats.byReason['show-not-in-front'] = (stats.byReason['show-not-in-front'] || 0) + 1;
    if (VERBOSE) console.log(`  WRONG ARTICLE: ${relFile} — show not in first 40% of text`);
    stats.failedFiles.push({ file: relFile, reason: 'show-not-in-front', outlet });
    continue;
  }

  // Step 5: Classify content tier
  const tier = classifyContentTier(cleaned, data);

  stats.reclaimable++;
  stats.reclaimedFiles.push({ file: relFile, outlet, chars: cleaned.length, tier: tier.tier, origReason });
  console.log(`  ✓ RECLAIMABLE: ${relFile} (${outlet}, ${cleaned.length} chars, ${tier.tier}, was: ${origReason})`);

  // Step 6: Apply if --apply flag is set
  if (APPLY) {
    data.fullText = cleaned;
    data.fullTextRecoveredFrom = 'garbageReaudit';
    data.textWordCount = cleaned.split(/\s+/).length;
    data.contentTier = tier.tier;
    data.contentTierReason = tier.reason;
    // Keep garbageFullText and garbageReason for audit trail
    fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
    stats.applied++;
  }
}

// Report
console.log('\n' + '='.repeat(60));
console.log('GARBAGE CONTENT RE-AUDIT RESULTS');
console.log('='.repeat(60));
console.log(`Total garbage-only files:   ${stats.totalGarbageOnly}`);
console.log(`Reclaimable:                ${stats.reclaimable}`);
console.log(`Still garbage:              ${stats.stillGarbage}`);
console.log(`  - Error/404 pages:        ${stats.errorPage}`);
console.log(`Wrong show content:         ${stats.wrongShow}`);
console.log(`Cleaned too short:          ${stats.tooShort}`);
if (APPLY) {
  console.log(`Applied:                    ${stats.applied}`);
} else {
  console.log(`\nRun with --apply to write changes to source files.`);
}

console.log('\n--- Reclaimable by outlet ---');
const outletCounts = {};
for (const r of stats.reclaimedFiles) {
  outletCounts[r.outlet] = (outletCounts[r.outlet] || 0) + 1;
}
Object.entries(outletCounts).sort((a, b) => b[1] - a[1]).forEach(([o, c]) => console.log(`  ${c} ${o}`));

console.log('\n--- Reclaimable by content tier ---');
const tierCounts = {};
for (const r of stats.reclaimedFiles) {
  tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
}
Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => console.log(`  ${c} ${t}`));

console.log('\n--- Still-failing reasons ---');
Object.entries(stats.byReason).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => console.log(`  ${c} ${r}`));

if (stats.reclaimedFiles.length > 0) {
  console.log('\n--- Reclaimed files ---');
  for (const r of stats.reclaimedFiles) {
    console.log(`  ${r.file} (${r.outlet}, ${r.chars} chars, ${r.tier})`);
  }
}
