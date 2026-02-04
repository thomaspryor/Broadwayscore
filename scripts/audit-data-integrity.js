#!/usr/bin/env node

/**
 * audit-data-integrity.js
 *
 * Comprehensive data integrity audit covering 4 investigation areas:
 *
 * 1. Wrong fullText / Content Mismatch — reviews with fullText that doesn't match the show
 * 2. Over-flagged wrongProduction — reviews that may be false positives
 * 3. Wrong URLs with Correct Scores — ticking time bombs that will produce wrong fullText
 * 4. Roundup Dedup — cross-show duplicate URLs that are legitimate roundup articles
 *
 * Uses verifyFullTextContent() from content-quality.js for content-to-show matching.
 *
 * Usage:
 *   node scripts/audit-data-integrity.js
 *   node scripts/audit-data-integrity.js --show=SLUG
 *   node scripts/audit-data-integrity.js --investigation=1
 *   node scripts/audit-data-integrity.js --verbose
 *   node scripts/audit-data-integrity.js --fix  (apply auto-fixes for confident mismatches)
 */

const fs = require('fs');
const path = require('path');
const { verifyFullTextContent } = require('./lib/content-quality');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');

// Parse CLI args
const args = process.argv.slice(2);
const SHOW_FILTER = args.find(a => a.startsWith('--show='))?.split('=')[1] || null;
const INV_FILTER = args.find(a => a.startsWith('--investigation='))?.split('=')[1] || null;
const VERBOSE = args.includes('--verbose');
const FIX_MODE = args.includes('--fix');

// Load shows
let showsData;
try {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  showsData = raw.shows || raw;
} catch (e) {
  console.error('Could not load shows.json:', e.message);
  process.exit(1);
}

// Build show lookup
const showById = {};
for (const s of showsData) {
  showById[s.id] = s;
}

// Known outlet → domain mappings (reused from audit-content-quality.js)
const OUTLET_DOMAINS = {
  washpost: ['washingtonpost.com'],
  nytimes: ['nytimes.com', 'nyti.ms'],
  wsj: ['wsj.com'],
  vulture: ['vulture.com', 'nymag.com', 'thecut.com'],
  newyorker: ['newyorker.com'],
  variety: ['variety.com'],
  deadline: ['deadline.com'],
  timeout: ['timeout.com'],
  guardian: ['theguardian.com'],
  nypost: ['nypost.com'],
  'hollywood-reporter': ['hollywoodreporter.com'],
  observer: ['observer.com'],
  ew: ['ew.com'],
  theatermania: ['theatermania.com'],
  thewrap: ['thewrap.com'],
  nydailynews: ['nydailynews.com'],
  chicagotribune: ['chicagotribune.com'],
  telegraph: ['telegraph.co.uk'],
  financialtimes: ['ft.com'],
  latimes: ['latimes.com'],
  thestage: ['thestage.co.uk'],
};

// Results
const results = {
  investigation1: { contentMismatches: [], probableMismatches: [] },
  investigation2: { categories: {}, likelyFalsePositives: [], confirmedCorrect: [] },
  investigation3: { suspiciousUrls: [] },
  investigation4: { roundupDuplicates: [], nonRoundupDuplicates: [] },
};

let totalFilesScanned = 0;
let totalWithFullText = 0;
let fixesApplied = 0;

// ========================================
// Get show directories to scan
// ========================================
const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name)
  .filter(d => !SHOW_FILTER || d === SHOW_FILTER);

console.log('=== Data Integrity Audit ===');
console.log(`Shows to scan: ${showDirs.length}`);
if (SHOW_FILTER) console.log(`Filtered to: ${SHOW_FILTER}`);
if (INV_FILTER) console.log(`Investigation: ${INV_FILTER}`);
if (FIX_MODE) console.log('FIX MODE: Will apply auto-fixes for confident mismatches\n');
console.log();

// ========================================
// URL tracking for Investigation 4
// ========================================
const urlToFiles = new Map();

// ========================================
// Scan all review files
// ========================================
for (const showDir of showDirs) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
  const show = showById[showDir];
  const files = fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    totalFilesScanned++;
    const filePath = path.join(dirPath, file);
    const relPath = `${showDir}/${file}`;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      continue;
    }

    // ---- Investigation 1: Wrong fullText / Content Mismatch ----
    if (!INV_FILTER || INV_FILTER === '1' || INV_FILTER === '5') {
      if (data.fullText && data.fullText.length > 200 &&
          !data.wrongProduction && !data.wrongShow && show) {
        totalWithFullText++;
        const result = verifyFullTextContent(data.fullText, show);

        if (result.verdict === 'confident_mismatch') {
          const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt);
          const entry = {
            file: relPath,
            showTitle: show.title,
            verdict: result.verdict,
            score: result.score,
            negativeSignalCount: result.negativeSignalCount,
            positiveSignals: result.positiveSignals,
            negativeSignals: result.negativeSignals,
            hasExcerpts,
            wrongShowMentioned: result.details.wrongShowMentioned,
            url: data.url ? data.url.substring(0, 100) : null,
          };

          // Try to identify which show the text IS about
          if (result.details.wrongShowMentioned) {
            entry.likelyActualShow = result.details.wrongShowMentioned;
          }

          results.investigation1.contentMismatches.push(entry);

          // Auto-fix: null fullText for confident mismatches with 2+ negative signals
          if (FIX_MODE && result.negativeSignalCount >= 2) {
            data.wrongFullText = data.fullText;
            data.fullText = null;
            data.contentMismatchNote = result.negativeSignals.join('; ');
            data.contentMismatchScore = result.score;
            data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            fixesApplied++;
            if (VERBOSE) console.log(`  FIXED: ${relPath} (score ${result.score})`);
          }
        } else if (result.verdict === 'probable_mismatch') {
          results.investigation1.probableMismatches.push({
            file: relPath,
            showTitle: show.title,
            score: result.score,
            negativeSignals: result.negativeSignals,
            positiveSignals: result.positiveSignals,
            url: data.url ? data.url.substring(0, 100) : null,
          });
        }
      }
    }

    // ---- Investigation 2: Over-flagged wrongProduction ----
    if ((!INV_FILTER || INV_FILTER === '2') && data.wrongProduction) {
      const note = data.wrongProductionNote || '';

      // Categorize by flagging method
      let category;
      if (note.includes('days before')) {
        category = 'published_before';
      } else if (note.toLowerCase().includes('url year') || note.toLowerCase().includes('url contains')) {
        category = 'url_year';
      } else if (note.toLowerCase().includes('off-broadway') || note.toLowerCase().includes('off broadway')) {
        category = 'manual_offbroadway';
      } else if (note.toLowerCase().includes('url') && note.toLowerCase().includes('manual')) {
        category = 'manual_url';
      } else if (note) {
        category = 'other_auto';
      } else {
        category = 'no_note';
      }

      if (!results.investigation2.categories[category]) {
        results.investigation2.categories[category] = 0;
      }
      results.investigation2.categories[category]++;

      // Check for false positives
      let isFalsePositive = false;
      let fpReason = '';

      // For "published before" flags: check if within preview window
      if (category === 'published_before' && show && data.publishDate) {
        const earliest = show.previewsStartDate || show.openingDate;
        if (earliest) {
          const pubDate = new Date(data.publishDate);
          const earliestDate = new Date(earliest);
          // Allow reviews from 30 days before previews start
          const previewWindow = new Date(earliestDate);
          previewWindow.setDate(previewWindow.getDate() - 30);

          if (pubDate >= previewWindow) {
            isFalsePositive = true;
            fpReason = `Published ${data.publishDate}, within preview window (previews: ${earliest})`;
          }
        }
      }

      // For "URL year" flags: run content verification
      if (category === 'url_year' && show && data.fullText && data.fullText.length > 200) {
        const contentResult = verifyFullTextContent(data.fullText, show);
        if (contentResult.verdict === 'confident_match' || contentResult.verdict === 'probable_match') {
          isFalsePositive = true;
          fpReason = `Content matches show (score ${contentResult.score}): ${contentResult.positiveSignals.join(', ')}`;
        }
      }

      // For "no note" or "other auto" flags with fullText: verify content
      if ((category === 'no_note' || category === 'other_auto') && show && data.fullText && data.fullText.length > 200) {
        const contentResult = verifyFullTextContent(data.fullText, show);
        if (contentResult.verdict === 'confident_match' || contentResult.verdict === 'probable_match') {
          isFalsePositive = true;
          fpReason = `Content matches show (score ${contentResult.score}): ${contentResult.positiveSignals.join(', ')}`;
        }
      }

      // Check if another production exists (makes the flag more likely correct)
      let otherProductionExists = false;
      if (show) {
        const baseTitle = show.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const s of showsData) {
          if (s.id !== show.id) {
            const otherBase = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (otherBase === baseTitle) {
              otherProductionExists = true;
              break;
            }
          }
        }
      }

      // Skip manual flags — those were human-verified
      if (category === 'manual_offbroadway' || category === 'manual_url') {
        results.investigation2.confirmedCorrect.push({
          file: relPath,
          category,
          note: note.substring(0, 100),
        });
      } else if (isFalsePositive && !otherProductionExists) {
        results.investigation2.likelyFalsePositives.push({
          file: relPath,
          category,
          reason: fpReason,
          note: note.substring(0, 100),
          otherProductionExists,
        });
      }
    }

    // ---- Investigation 3: Wrong URLs with Correct Scores ----
    if (!INV_FILTER || INV_FILTER === '3') {
      if (data.assignedScore && (!data.fullText || data.fullText.length < 100) && data.url) {
        let suspicious = false;
        let reason = '';

        // Check for film/TV URL patterns
        try {
          const urlPath = new URL(data.url).pathname.toLowerCase();
          if (urlPath.includes('/film/') || urlPath.includes('/films/') ||
              urlPath.includes('/tv/') || urlPath.includes('/television/') ||
              urlPath.includes('/movie/') || urlPath.includes('/movies/') ||
              urlPath.includes('/streaming/')) {
            suspicious = true;
            reason = `URL contains non-theater segment: ${urlPath.substring(0, 80)}`;
          }
        } catch (e) { /* invalid URL */ }

        // Check domain-outlet mismatch
        if (!suspicious && data.outletId && OUTLET_DOMAINS[data.outletId]) {
          try {
            const urlDomain = new URL(data.url).hostname.replace('www.', '');
            const expectedDomains = OUTLET_DOMAINS[data.outletId];
            if (!expectedDomains.some(d => urlDomain.includes(d))) {
              suspicious = true;
              reason = `Domain mismatch: ${data.outletId} -> ${urlDomain} (expected: ${expectedDomains.join(', ')})`;
            }
          } catch (e) { /* invalid URL */ }
        }

        if (suspicious) {
          results.investigation3.suspiciousUrls.push({
            file: relPath,
            url: data.url.substring(0, 100),
            outletId: data.outletId,
            assignedScore: data.assignedScore,
            reason,
          });
        }
      }
    }

    // ---- Investigation 4: Track URLs for roundup dedup ----
    if (!INV_FILTER || INV_FILTER === '4') {
      if (data.url) {
        if (!urlToFiles.has(data.url)) {
          urlToFiles.set(data.url, []);
        }
        urlToFiles.get(data.url).push({
          file: relPath,
          showDir,
          isRoundup: data.isRoundupArticle === true,
        });
      }
    }
  }
}

// ---- Investigation 4: Process cross-show duplicates ----
if (!INV_FILTER || INV_FILTER === '4') {
  for (const [url, entries] of urlToFiles) {
    if (entries.length <= 1) continue;
    const shows = new Set(entries.map(e => e.showDir));
    if (shows.size <= 1) continue;

    const hasRoundup = entries.some(e => e.isRoundup);
    if (hasRoundup) {
      results.investigation4.roundupDuplicates.push({
        url: url.substring(0, 100),
        files: entries.map(e => e.file),
        showCount: shows.size,
      });
    } else {
      results.investigation4.nonRoundupDuplicates.push({
        url: url.substring(0, 100),
        files: entries.map(e => e.file),
        showCount: shows.size,
      });
    }
  }
}

// ========================================
// Report
// ========================================
console.log('\n=== Results ===\n');
console.log(`Scanned ${totalFilesScanned} files across ${showDirs.length} shows`);
console.log(`Files with fullText > 200 chars: ${totalWithFullText}\n`);

// Investigation 1
if (!INV_FILTER || INV_FILTER === '1' || INV_FILTER === '5') {
  console.log('--- Investigation 1+5: Content Mismatches ---');
  console.log(`  Confident mismatches: ${results.investigation1.contentMismatches.length}`);
  console.log(`  Probable mismatches:  ${results.investigation1.probableMismatches.length}`);

  if (results.investigation1.contentMismatches.length > 0) {
    console.log('\n  Confident mismatches:');
    for (const m of results.investigation1.contentMismatches) {
      console.log(`    ${m.file} (score ${m.score})`);
      console.log(`      Show: ${m.showTitle}`);
      console.log(`      -: ${m.negativeSignals.join('; ')}`);
      if (m.positiveSignals.length > 0) {
        console.log(`      +: ${m.positiveSignals.join('; ')}`);
      }
      if (m.likelyActualShow) {
        console.log(`      Likely actual show: ${m.likelyActualShow}`);
      }
      console.log(`      Has excerpts: ${m.hasExcerpts} | URL: ${m.url || 'none'}`);
    }
  }

  if (VERBOSE && results.investigation1.probableMismatches.length > 0) {
    console.log('\n  Probable mismatches (manual review recommended):');
    for (const m of results.investigation1.probableMismatches) {
      console.log(`    ${m.file} (score ${m.score})`);
      console.log(`      -: ${m.negativeSignals.join('; ')}`);
    }
  }
  console.log();
}

// Investigation 2
if (!INV_FILTER || INV_FILTER === '2') {
  console.log('--- Investigation 2: Over-flagged wrongProduction ---');
  console.log('  Categories:');
  for (const [cat, count] of Object.entries(results.investigation2.categories)) {
    console.log(`    ${cat}: ${count}`);
  }
  console.log(`  Likely false positives: ${results.investigation2.likelyFalsePositives.length}`);
  console.log(`  Confirmed correct (manual): ${results.investigation2.confirmedCorrect.length}`);

  if (results.investigation2.likelyFalsePositives.length > 0) {
    console.log('\n  Likely false positives:');
    for (const fp of results.investigation2.likelyFalsePositives) {
      console.log(`    ${fp.file}`);
      console.log(`      Category: ${fp.category}`);
      console.log(`      Reason: ${fp.reason}`);
      if (VERBOSE) console.log(`      Note: ${fp.note}`);
    }
  }
  console.log();
}

// Investigation 3
if (!INV_FILTER || INV_FILTER === '3') {
  console.log('--- Investigation 3: Suspicious URLs (no fullText) ---');
  console.log(`  Suspicious URLs: ${results.investigation3.suspiciousUrls.length}`);

  if (results.investigation3.suspiciousUrls.length > 0) {
    for (const s of results.investigation3.suspiciousUrls) {
      console.log(`    ${s.file}: ${s.reason}`);
      if (VERBOSE) console.log(`      URL: ${s.url} | Score: ${s.assignedScore}`);
    }
  }
  console.log();
}

// Investigation 4
if (!INV_FILTER || INV_FILTER === '4') {
  console.log('--- Investigation 4: Cross-show Duplicate URLs ---');
  console.log(`  Roundup articles (legitimate): ${results.investigation4.roundupDuplicates.length}`);
  console.log(`  Non-roundup duplicates:        ${results.investigation4.nonRoundupDuplicates.length}`);

  if (results.investigation4.nonRoundupDuplicates.length > 0) {
    console.log('\n  Non-roundup duplicates:');
    for (const d of results.investigation4.nonRoundupDuplicates) {
      console.log(`    ${d.url}`);
      for (const f of d.files) {
        console.log(`      - ${f}`);
      }
    }
  }
  console.log();
}

// Fix summary
if (FIX_MODE) {
  console.log(`\nFixes applied: ${fixesApplied}`);
}

// Summary
const totalIssues =
  results.investigation1.contentMismatches.length +
  results.investigation1.probableMismatches.length +
  results.investigation2.likelyFalsePositives.length +
  results.investigation3.suspiciousUrls.length +
  results.investigation4.nonRoundupDuplicates.length;

console.log(`\nTotal issues found: ${totalIssues}`);

// Write report
const reportPath = path.join(DATA_DIR, 'audit', 'data-integrity-report.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  auditedAt: new Date().toISOString(),
  totalFilesScanned,
  totalWithFullText,
  fixesApplied,
  totalIssues,
  results,
}, null, 2) + '\n');
console.log(`Report written to ${reportPath}`);
