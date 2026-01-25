#!/usr/bin/env node
/**
 * check-show-freshness.js
 *
 * Comprehensive freshness check for Broadway show data:
 * 1. Auto-closes shows when their closingDate passes
 * 2. Reports shows closing soon
 * 3. Flags missing/incomplete data (images, synopsis, tickets, etc.)
 * 4. Generates a data quality report
 *
 * Usage: node scripts/check-show-freshness.js [--dry-run] [--json]
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const REPORT_FILE = path.join(__dirname, '..', 'data', 'freshness-report.json');

const dryRun = process.argv.includes('--dry-run');
const jsonOutput = process.argv.includes('--json');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function isDatePassed(dateStr) {
  if (!dateStr) return false;
  const closeDate = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  closeDate.setHours(0, 0, 0, 0);
  return closeDate < today;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const closeDate = new Date(dateStr);
  const today = new Date();
  const diffTime = closeDate.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function checkShowCompleteness(show) {
  const issues = [];
  const isOpen = show.status === 'open';

  // Images
  if (!show.images?.poster) {
    issues.push({ type: 'missing_poster', severity: 'high' });
  }
  if (!show.images?.hero) {
    issues.push({ type: 'missing_hero', severity: 'medium' });
  }
  if (!show.images?.thumbnail) {
    issues.push({ type: 'missing_thumbnail', severity: 'low' });
  }

  // Synopsis
  if (!show.synopsis || show.synopsis.length < 50) {
    issues.push({ type: 'missing_synopsis', severity: 'high' });
  }

  // Ticket links (only for open shows)
  if (isOpen && (!show.ticketLinks || show.ticketLinks.length === 0)) {
    issues.push({ type: 'missing_tickets', severity: 'high' });
  }

  // Cast & Creative
  if (!show.cast || show.cast.length === 0) {
    issues.push({ type: 'missing_cast', severity: 'medium' });
  }
  if (!show.creativeTeam || show.creativeTeam.length === 0) {
    issues.push({ type: 'missing_creative', severity: 'medium' });
  }

  // Runtime
  if (!show.runtime) {
    issues.push({ type: 'missing_runtime', severity: 'low' });
  }

  // Age recommendation
  if (!show.ageRecommendation) {
    issues.push({ type: 'missing_age_rec', severity: 'low' });
  }

  // Closing date for open shows (informational, not an issue)
  if (isOpen && !show.closingDate) {
    issues.push({ type: 'no_closing_date', severity: 'info' });
  }

  return issues;
}

function checkFreshness() {
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.split('T')[0];

  if (!jsonOutput) {
    console.log('='.repeat(60));
    console.log('BROADWAY SHOW DATA FRESHNESS CHECK');
    console.log('='.repeat(60));
    console.log(`Date: ${dateStr}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log('');
  }

  const data = loadShows();
  const allShows = data.shows;
  const openShows = allShows.filter(s => s.status === 'open');
  const closedShows = allShows.filter(s => s.status === 'closed');

  const report = {
    generatedAt: timestamp,
    summary: {
      totalShows: allShows.length,
      openShows: openShows.length,
      closedShows: closedShows.length,
    },
    statusChanges: {
      autoClosed: [],
    },
    closingSoon: [],
    dataQuality: {
      complete: [],
      hasIssues: [],
      byIssueType: {},
    },
  };

  // Check status changes
  for (const show of openShows) {
    if (show.closingDate && isDatePassed(show.closingDate)) {
      report.statusChanges.autoClosed.push({
        id: show.id,
        title: show.title,
        closingDate: show.closingDate,
      });

      if (!dryRun) {
        show.status = 'closed';
      }
    } else if (show.closingDate) {
      const days = daysUntil(show.closingDate);
      if (days !== null && days <= 60 && days > 0) {
        report.closingSoon.push({
          id: show.id,
          title: show.title,
          closingDate: show.closingDate,
          daysLeft: days,
        });
      }
    }
  }

  // Sort closing soon by days left
  report.closingSoon.sort((a, b) => a.daysLeft - b.daysLeft);

  // Check data completeness for open shows
  for (const show of openShows) {
    const issues = checkShowCompleteness(show);
    const significantIssues = issues.filter(i => i.severity !== 'info');

    if (significantIssues.length === 0) {
      report.dataQuality.complete.push(show.id);
    } else {
      report.dataQuality.hasIssues.push({
        id: show.id,
        title: show.title,
        issues: issues,
      });

      // Aggregate by issue type
      for (const issue of issues) {
        if (!report.dataQuality.byIssueType[issue.type]) {
          report.dataQuality.byIssueType[issue.type] = [];
        }
        report.dataQuality.byIssueType[issue.type].push(show.title);
      }
    }
  }

  // Save shows if changes made
  if (!dryRun && report.statusChanges.autoClosed.length > 0) {
    saveShows(data);
  }

  // Save report
  if (!dryRun) {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
  }

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  // GitHub Actions outputs
  if (report.statusChanges.autoClosed.length > 0 && !dryRun) {
    const closedNames = report.statusChanges.autoClosed.map(s => s.title).join(', ');
    console.log('');
    console.log(`::notice::Auto-closed ${report.statusChanges.autoClosed.length} shows: ${closedNames}`);
  }

  return report;
}

function printReport(report) {
  // Status Changes
  if (report.statusChanges.autoClosed.length > 0) {
    console.log('AUTO-CLOSED (closing date passed):');
    console.log('-'.repeat(40));
    for (const show of report.statusChanges.autoClosed) {
      console.log(`  ❌ ${show.title} (closed ${show.closingDate})`);
    }
    console.log('');
  }

  // Closing Soon
  if (report.closingSoon.length > 0) {
    console.log('CLOSING SOON (within 60 days):');
    console.log('-'.repeat(40));
    for (const show of report.closingSoon) {
      const urgency = show.daysLeft <= 7 ? '🔴' : show.daysLeft <= 14 ? '🟡' : '🟢';
      console.log(`  ${urgency} ${show.title}: ${show.daysLeft} days (${show.closingDate})`);
    }
    console.log('');
  }

  // Data Quality Issues
  const issueTypes = Object.keys(report.dataQuality.byIssueType);
  if (issueTypes.length > 0) {
    console.log('DATA QUALITY ISSUES (open shows):');
    console.log('-'.repeat(40));

    const severityOrder = ['missing_poster', 'missing_synopsis', 'missing_tickets', 'missing_hero', 'missing_cast', 'missing_creative', 'missing_thumbnail', 'missing_runtime', 'missing_age_rec', 'no_closing_date'];
    const sortedTypes = issueTypes.sort((a, b) => severityOrder.indexOf(a) - severityOrder.indexOf(b));

    for (const type of sortedTypes) {
      const shows = report.dataQuality.byIssueType[type];
      const label = type.replace(/_/g, ' ').replace(/^missing /, '⚠️  Missing ').replace(/^no /, '📋 No ');
      console.log(`  ${label}: ${shows.length} shows`);
      if (shows.length <= 5) {
        for (const title of shows) {
          console.log(`      - ${title}`);
        }
      } else {
        for (const title of shows.slice(0, 3)) {
          console.log(`      - ${title}`);
        }
        console.log(`      ... and ${shows.length - 3} more`);
      }
    }
    console.log('');
  }

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total shows: ${report.summary.totalShows} (${report.summary.openShows} open, ${report.summary.closedShows} closed)`);
  console.log(`Auto-closed today: ${report.statusChanges.autoClosed.length}`);
  console.log(`Closing within 60 days: ${report.closingSoon.length}`);
  console.log(`Open shows with complete data: ${report.dataQuality.complete.length}/${report.summary.openShows}`);
  console.log(`Open shows with issues: ${report.dataQuality.hasIssues.length}`);
}

// Run
checkFreshness();
