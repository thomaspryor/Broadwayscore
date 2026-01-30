#!/usr/bin/env node
/**
 * Generate Integrity Report
 *
 * Tracks data quality metrics over time and generates reports for monitoring.
 *
 * Metrics tracked (4 essential):
 * 1. Total review count (should not decrease week-over-week)
 * 2. Reviews with unknown outlets (should be 0)
 * 3. Duplicate review count (should be 0)
 * 4. reviews.json vs review-texts sync (counts should match)
 *
 * Outputs:
 * - data/integrity-report.json (current metrics + hasIssues flag)
 * - data/integrity-report.md (human-readable report)
 * - data/integrity-history.json (weekly snapshots, last 12 weeks)
 */

const fs = require('fs');
const path = require('path');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const REVIEWS_JSON_PATH = path.join(DATA_DIR, 'reviews.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');
const HISTORY_PATH = path.join(DATA_DIR, 'integrity-history.json');
const REPORT_JSON_PATH = path.join(DATA_DIR, 'integrity-report.json');
const REPORT_MD_PATH = path.join(DATA_DIR, 'integrity-report.md');

// Constants
const DEGRADATION_THRESHOLD = 0.05; // 5%
const MAX_HISTORY_WEEKS = 12;

/**
 * Load the outlet registry to check for unknown outlets
 */
function loadOutletRegistry() {
  try {
    const data = fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf-8');
    const registry = JSON.parse(data);

    // Build a set of all known outlet IDs (including aliases)
    const knownOutlets = new Set();

    for (const [outletId, outletData] of Object.entries(registry.outlets || {})) {
      knownOutlets.add(outletId.toLowerCase());
      if (outletData.aliases) {
        for (const alias of outletData.aliases) {
          knownOutlets.add(alias.toLowerCase());
        }
      }
    }

    // Add alias index entries
    if (registry._aliasIndex) {
      for (const alias of Object.keys(registry._aliasIndex)) {
        if (alias !== '_note') {
          knownOutlets.add(alias.toLowerCase());
        }
      }
    }

    return knownOutlets;
  } catch (err) {
    console.warn('Warning: Could not load outlet registry:', err.message);
    return new Set();
  }
}

/**
 * Count reviews in review-texts directory
 */
function countReviewTexts() {
  const knownOutlets = loadOutletRegistry();

  let totalReviews = 0;
  let unknownOutlets = 0;
  const reviewKeys = new Set(); // For duplicate detection
  let duplicates = 0;
  const unknownOutletsList = [];
  const duplicatesList = [];

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    });

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      totalReviews++;

      const filePath = path.join(showPath, file);
      let data;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        data = JSON.parse(content);
      } catch (err) {
        // Skip invalid JSON
        continue;
      }

      // Check for unknown outlets
      const outletId = (data.outletId || '').toLowerCase();
      const outlet = (data.outlet || '').toLowerCase();

      const isKnown = knownOutlets.has(outletId) ||
                      knownOutlets.has(outlet) ||
                      (outletId && knownOutlets.has(outletId.replace(/-/g, ' '))) ||
                      (outlet && knownOutlets.has(outlet.replace(/-/g, ' ')));

      if (!isKnown && (outletId || outlet)) {
        unknownOutlets++;
        if (unknownOutletsList.length < 10) {
          unknownOutletsList.push({
            file: path.join('data/review-texts', showDir, file),
            outletId: data.outletId,
            outlet: data.outlet
          });
        }
      }

      // Check for duplicates (same show + outlet + critic)
      const criticName = (data.criticName || 'unknown').toLowerCase().trim();
      const key = `${showDir}|${outletId || outlet}|${criticName}`;

      if (reviewKeys.has(key)) {
        duplicates++;
        if (duplicatesList.length < 10) {
          duplicatesList.push({
            file: path.join('data/review-texts', showDir, file),
            key
          });
        }
      } else {
        reviewKeys.add(key);
      }
    }
  }

  return {
    totalReviews,
    unknownOutlets,
    duplicates,
    unknownOutletsList,
    duplicatesList
  };
}

/**
 * Count reviews in reviews.json
 */
function countReviewsJson() {
  try {
    const data = fs.readFileSync(REVIEWS_JSON_PATH, 'utf-8');
    const reviews = JSON.parse(data);
    return reviews.reviews ? reviews.reviews.length : 0;
  } catch (err) {
    console.warn('Warning: Could not read reviews.json:', err.message);
    return 0;
  }
}

/**
 * Load integrity history
 */
function loadHistory() {
  try {
    const data = fs.readFileSync(HISTORY_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return { weeks: [] };
  }
}

/**
 * Save integrity history
 */
function saveHistory(history) {
  // Keep only the last 12 weeks
  if (history.weeks.length > MAX_HISTORY_WEEKS) {
    history.weeks = history.weeks.slice(-MAX_HISTORY_WEEKS);
  }
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Generate the integrity report
 */
function generateReport() {
  console.log('=== Generating Integrity Report ===\n');

  const today = new Date().toISOString().split('T')[0];

  // Collect current metrics
  console.log('Counting review-text files...');
  const reviewTextStats = countReviewTexts();

  console.log('Counting reviews.json entries...');
  const reviewsJsonCount = countReviewsJson();

  const currentMetrics = {
    date: today,
    totalReviews: reviewTextStats.totalReviews,
    unknownOutlets: reviewTextStats.unknownOutlets,
    duplicates: reviewTextStats.duplicates,
    syncDelta: Math.abs(reviewTextStats.totalReviews - reviewsJsonCount)
  };

  console.log(`\nCurrent Metrics:`);
  console.log(`  Total Reviews: ${currentMetrics.totalReviews}`);
  console.log(`  Unknown Outlets: ${currentMetrics.unknownOutlets}`);
  console.log(`  Duplicates: ${currentMetrics.duplicates}`);
  console.log(`  Sync Delta: ${currentMetrics.syncDelta} (review-texts: ${reviewTextStats.totalReviews}, reviews.json: ${reviewsJsonCount})`);

  // Load history
  const history = loadHistory();
  const previousMetrics = history.weeks.length > 0 ? history.weeks[history.weeks.length - 1] : null;

  // Determine if there are issues
  const issues = [];

  // Check for review count decrease
  if (previousMetrics && currentMetrics.totalReviews < previousMetrics.totalReviews) {
    const decrease = previousMetrics.totalReviews - currentMetrics.totalReviews;
    const percentDecrease = (decrease / previousMetrics.totalReviews) * 100;
    issues.push({
      type: 'review_count_decrease',
      severity: percentDecrease > 5 ? 'critical' : 'warning',
      message: `Review count decreased by ${decrease} (${percentDecrease.toFixed(1)}%) from ${previousMetrics.totalReviews} to ${currentMetrics.totalReviews}`
    });
  }

  // Check for unknown outlets
  if (currentMetrics.unknownOutlets > 0) {
    issues.push({
      type: 'unknown_outlets',
      severity: currentMetrics.unknownOutlets > 10 ? 'critical' : 'warning',
      message: `${currentMetrics.unknownOutlets} reviews have unknown outlets`,
      examples: reviewTextStats.unknownOutletsList
    });
  }

  // Check for duplicates
  if (currentMetrics.duplicates > 0) {
    issues.push({
      type: 'duplicates',
      severity: currentMetrics.duplicates > 10 ? 'critical' : 'warning',
      message: `${currentMetrics.duplicates} duplicate reviews detected`,
      examples: reviewTextStats.duplicatesList
    });
  }

  // Check for sync delta
  if (currentMetrics.syncDelta > 10) {
    issues.push({
      type: 'sync_delta',
      severity: currentMetrics.syncDelta > 50 ? 'critical' : 'warning',
      message: `review-texts (${reviewTextStats.totalReviews}) and reviews.json (${reviewsJsonCount}) are out of sync by ${currentMetrics.syncDelta} reviews`
    });
  }

  // Check for degradation compared to previous week
  if (previousMetrics) {
    // Unknown outlets increasing
    if (currentMetrics.unknownOutlets > previousMetrics.unknownOutlets * (1 + DEGRADATION_THRESHOLD)) {
      issues.push({
        type: 'unknown_outlets_degradation',
        severity: 'warning',
        message: `Unknown outlets increased from ${previousMetrics.unknownOutlets} to ${currentMetrics.unknownOutlets}`
      });
    }

    // Duplicates increasing
    if (currentMetrics.duplicates > previousMetrics.duplicates * (1 + DEGRADATION_THRESHOLD)) {
      issues.push({
        type: 'duplicates_degradation',
        severity: 'warning',
        message: `Duplicates increased from ${previousMetrics.duplicates} to ${currentMetrics.duplicates}`
      });
    }
  }

  const hasIssues = issues.some(i => i.severity === 'critical') || issues.length > 2;

  // Generate reports
  const jsonReport = {
    timestamp: new Date().toISOString(),
    hasIssues,
    current: currentMetrics,
    previous: previousMetrics,
    issues,
    summary: {
      totalReviews: currentMetrics.totalReviews,
      unknownOutlets: currentMetrics.unknownOutlets,
      duplicates: currentMetrics.duplicates,
      syncDelta: currentMetrics.syncDelta
    }
  };

  // Generate markdown report
  const mdReport = generateMarkdownReport(currentMetrics, previousMetrics, issues);

  // Save reports
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(jsonReport, null, 2));
  fs.writeFileSync(REPORT_MD_PATH, mdReport);

  // Update history (only add if different date from last entry)
  if (!previousMetrics || previousMetrics.date !== today) {
    history.weeks.push(currentMetrics);
    saveHistory(history);
    console.log('\nHistory updated.');
  } else {
    // Update today's entry
    history.weeks[history.weeks.length - 1] = currentMetrics;
    saveHistory(history);
    console.log('\nToday\'s history entry updated.');
  }

  console.log(`\nReports saved:`);
  console.log(`  ${REPORT_JSON_PATH}`);
  console.log(`  ${REPORT_MD_PATH}`);
  console.log(`  ${HISTORY_PATH}`);

  if (hasIssues) {
    console.log(`\n*** ISSUES FOUND: ${issues.length} issue(s) detected ***`);
    for (const issue of issues) {
      console.log(`  [${issue.severity.toUpperCase()}] ${issue.message}`);
    }
  } else {
    console.log('\nNo issues found. Data quality is good.');
  }

  return hasIssues;
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(current, previous, issues) {
  const formatChange = (curr, prev) => {
    if (prev === null || prev === undefined) return '-';
    const diff = curr - prev;
    if (diff === 0) return '-';
    return diff > 0 ? `+${diff}` : `${diff}`;
  };

  let md = `# Data Integrity Report - ${current.date}\n\n`;

  // Summary table
  md += `## Summary\n\n`;
  md += `| Metric | Current | Previous | Change |\n`;
  md += `|--------|---------|----------|--------|\n`;
  md += `| Total Reviews | ${current.totalReviews} | ${previous?.totalReviews ?? '-'} | ${formatChange(current.totalReviews, previous?.totalReviews)} |\n`;
  md += `| Unknown Outlets | ${current.unknownOutlets} | ${previous?.unknownOutlets ?? '-'} | ${formatChange(current.unknownOutlets, previous?.unknownOutlets)} |\n`;
  md += `| Duplicates | ${current.duplicates} | ${previous?.duplicates ?? '-'} | ${formatChange(current.duplicates, previous?.duplicates)} |\n`;
  md += `| Sync Delta | ${current.syncDelta} | ${previous?.syncDelta ?? '-'} | ${formatChange(current.syncDelta, previous?.syncDelta)} |\n`;
  md += `\n`;

  // Issues section
  md += `## Issues Found\n\n`;
  if (issues.length === 0) {
    md += `None\n\n`;
  } else {
    for (const issue of issues) {
      md += `### ${issue.severity === 'critical' ? '🔴' : '🟡'} ${issue.type}\n\n`;
      md += `${issue.message}\n\n`;
      if (issue.examples && issue.examples.length > 0) {
        md += `**Examples:**\n`;
        for (const ex of issue.examples.slice(0, 5)) {
          if (ex.file) {
            md += `- \`${ex.file}\``;
            if (ex.outletId) md += ` (outletId: ${ex.outletId})`;
            if (ex.outlet) md += ` (outlet: ${ex.outlet})`;
            md += `\n`;
          }
        }
        md += `\n`;
      }
    }
  }

  // Recommendations
  md += `## Recommendations\n\n`;
  if (issues.length === 0) {
    md += `- Continue monitoring\n`;
    md += `- No action required\n`;
  } else {
    if (issues.some(i => i.type.includes('unknown_outlets'))) {
      md += `- Run \`node scripts/audit-outlet-registry.js\` to identify and add missing outlets\n`;
    }
    if (issues.some(i => i.type.includes('duplicate'))) {
      md += `- Run \`node scripts/audit-review-duplicates.js\` to identify duplicate reviews\n`;
    }
    if (issues.some(i => i.type === 'sync_delta')) {
      md += `- Run \`node scripts/rebuild-all-reviews.js\` to sync reviews.json with review-texts\n`;
    }
    if (issues.some(i => i.type === 'review_count_decrease')) {
      md += `- Investigate missing reviews - check recent git history for deleted files\n`;
    }
  }
  md += `\n`;

  // Metadata
  md += `---\n\n`;
  md += `*Report generated: ${new Date().toISOString()}*\n`;

  return md;
}

// Run if called directly
if (require.main === module) {
  const hasIssues = generateReport();
  // Don't exit with error code - let the workflow decide based on hasIssues
  process.exit(0);
}

module.exports = { generateReport };
