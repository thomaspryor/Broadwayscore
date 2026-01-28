#!/usr/bin/env node
/**
 * Task 1.0: File Integrity Audit
 *
 * Checks all review files in data/review-texts/ for:
 * - Valid JSON parsing
 * - Non-empty files (>0 bytes)
 * - Required fields present: showId, outletId, outlet, criticName
 *
 * Output: data/audit/file-integrity.json
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'file-integrity.json');

const REQUIRED_FIELDS = ['showId', 'outletId', 'outlet', 'criticName'];

function auditFileIntegrity() {
  console.log('=== File Integrity Audit ===\n');

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_files: 0,
      valid_files: 0,
      issues_found: 0,
      empty_files: 0,
      invalid_json: 0,
      missing_required_fields: 0
    },
    issues: []
  };

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    });

  console.log(`Found ${showDirs.length} show directories\n`);

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath)
      .filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showPath, file);
      const relativePath = path.join('data/review-texts', showDir, file);
      report.summary.total_files++;

      // Check 1: File size (empty files)
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        report.summary.issues_found++;
        report.summary.empty_files++;
        report.issues.push({
          file: relativePath,
          type: 'empty_file',
          severity: 'critical',
          message: 'File is empty (0 bytes)'
        });
        continue; // Can't check JSON if empty
      }

      // Check 2: Valid JSON
      let data;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        data = JSON.parse(content);
      } catch (e) {
        report.summary.issues_found++;
        report.summary.invalid_json++;
        report.issues.push({
          file: relativePath,
          type: 'invalid_json',
          severity: 'critical',
          message: `JSON parse error: ${e.message}`
        });
        continue; // Can't check fields if JSON is invalid
      }

      // Check 3: Required fields present
      const missingFields = REQUIRED_FIELDS.filter(field => !data[field]);
      if (missingFields.length > 0) {
        report.summary.issues_found++;
        report.summary.missing_required_fields++;
        report.issues.push({
          file: relativePath,
          type: 'missing_required_fields',
          severity: 'high',
          message: `Missing required fields: ${missingFields.join(', ')}`,
          details: {
            missing: missingFields,
            present: REQUIRED_FIELDS.filter(f => data[f])
          }
        });
        continue;
      }

      // Check 4: Required fields have "unknown" value (data quality issue)
      const unknownFields = REQUIRED_FIELDS.filter(field =>
        data[field] && data[field].toString().toLowerCase() === 'unknown'
      );
      if (unknownFields.length > 0) {
        report.summary.issues_found++;
        if (!report.summary.unknown_value_fields) report.summary.unknown_value_fields = 0;
        report.summary.unknown_value_fields++;
        report.issues.push({
          file: relativePath,
          type: 'unknown_value_fields',
          severity: 'medium',
          message: `Fields with 'unknown' value: ${unknownFields.join(', ')}`,
          details: {
            unknown_fields: unknownFields.map(f => ({ field: f, value: data[f] }))
          }
        });
        // Don't continue - still count as valid for structure, but flag for data quality
      }

      // File passed structural checks
      report.summary.valid_files++;
    }
  }

  // Also check for failed-fetches.json at root level (skip it from validation)
  const rootFiles = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of rootFiles) {
    const filePath = path.join(REVIEW_TEXTS_DIR, file);
    const relativePath = path.join('data/review-texts', file);

    // Root-level files are unexpected
    report.issues.push({
      file: relativePath,
      type: 'unexpected_location',
      severity: 'warning',
      message: 'Review file found at root level instead of show directory'
    });
    report.summary.issues_found++;
  }

  // Print summary
  console.log('Summary:');
  console.log(`  Total files scanned: ${report.summary.total_files}`);
  console.log(`  Valid files: ${report.summary.valid_files}`);
  console.log(`  Issues found: ${report.summary.issues_found}`);
  console.log(`    - Empty files: ${report.summary.empty_files}`);
  console.log(`    - Invalid JSON: ${report.summary.invalid_json}`);
  console.log(`    - Missing required fields: ${report.summary.missing_required_fields}`);

  if (report.issues.length > 0) {
    console.log('\nIssues:');
    for (const issue of report.issues.slice(0, 20)) {
      console.log(`  [${issue.severity.toUpperCase()}] ${issue.file}: ${issue.message}`);
    }
    if (report.issues.length > 20) {
      console.log(`  ... and ${report.issues.length - 20} more issues`);
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write report
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${OUTPUT_PATH}`);

  // Return success/failure based on critical issues
  const criticalIssues = report.issues.filter(i => i.severity === 'critical');
  if (criticalIssues.length > 0) {
    console.log(`\nFAILED: ${criticalIssues.length} critical issues found`);
    return false;
  }

  console.log('\nPASSED: No critical file integrity issues');
  return true;
}

// Run if called directly
if (require.main === module) {
  const success = auditFileIntegrity();
  process.exit(success ? 0 : 1);
}

module.exports = { auditFileIntegrity };
