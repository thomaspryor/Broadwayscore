#!/usr/bin/env npx ts-node
/**
 * Broadway Scorecard Agent Updater
 *
 * This script checks for new reviews, audience data, and buzz signals,
 * then proposes updates to the data files.
 *
 * Usage: npm run agent:update
 *
 * The agent will:
 * 1. Check each show for missing or outdated data
 * 2. Search for new critic reviews (where accessible)
 * 3. Check audience platforms for updated scores
 * 4. Search Reddit for new buzz threads
 * 5. Generate a "needs review" report
 * 6. Optionally output proposed data updates
 */

import * as fs from 'fs';
import * as path from 'path';

// Data file paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const AUDIENCE_FILE = path.join(DATA_DIR, 'audience.json');
const BUZZ_FILE = path.join(DATA_DIR, 'buzz.json');

// Load current data
function loadJSON(filepath: string): any {
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

interface UpdateReport {
  timestamp: string;
  showsChecked: number;
  issues: Issue[];
  suggestions: Suggestion[];
}

interface Issue {
  showId: string;
  showTitle: string;
  type: 'missing_reviews' | 'missing_audience' | 'missing_buzz' | 'stale_data' | 'low_confidence';
  message: string;
  severity: 'high' | 'medium' | 'low';
}

interface Suggestion {
  showId: string;
  showTitle: string;
  type: 'add_review' | 'update_audience' | 'add_buzz_thread';
  data: any;
  source?: string;
}

// Known critic outlets to check
const OUTLETS_TO_CHECK = [
  'The New York Times',
  'Vulture',
  'Variety',
  'The Hollywood Reporter',
  'Time Out New York',
  'The Washington Post',
  'TheaterMania',
  'BroadwayWorld',
];

// Audience platforms to check
const AUDIENCE_PLATFORMS = ['showscore', 'google'];

function analyzeShow(
  show: any,
  reviews: any[],
  audienceData: any[],
  buzzThreads: any[]
): { issues: Issue[]; suggestions: Suggestion[] } {
  const issues: Issue[] = [];
  const suggestions: Suggestion[] = [];

  const showReviews = reviews.filter((r: any) => r.showId === show.id);
  const showAudience = audienceData.filter((a: any) => a.showId === show.id);
  const showBuzz = buzzThreads.filter((t: any) => t.showId === show.id);

  // Check for missing Tier 1 reviews
  const tier1Outlets = ['The New York Times', 'Vulture', 'Variety', 'The Hollywood Reporter', 'Time Out New York', 'The Washington Post'];
  const reviewedOutlets = showReviews.map((r: any) => r.outlet);
  const missingTier1 = tier1Outlets.filter(o => !reviewedOutlets.includes(o));

  if (missingTier1.length > 3) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'missing_reviews',
      message: `Missing ${missingTier1.length} Tier 1 reviews: ${missingTier1.join(', ')}`,
      severity: 'high',
    });
  } else if (missingTier1.length > 0) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'missing_reviews',
      message: `Missing Tier 1 reviews: ${missingTier1.join(', ')}`,
      severity: 'medium',
    });
  }

  // Check for missing audience platforms
  const audiencePlatforms = showAudience.map((a: any) => a.platform);
  if (!audiencePlatforms.includes('showscore')) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'missing_audience',
      message: 'Missing Show-Score data',
      severity: 'medium',
    });
  }
  if (!audiencePlatforms.includes('google')) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'missing_audience',
      message: 'Missing Google Reviews data',
      severity: 'low',
    });
  }

  // Check for buzz data
  if (showBuzz.length === 0) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'missing_buzz',
      message: 'No buzz threads tracked',
      severity: 'medium',
    });
  } else if (showBuzz.length < 3) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'missing_buzz',
      message: `Only ${showBuzz.length} buzz threads tracked (3+ recommended)`,
      severity: 'low',
    });
  }

  // Check for stale buzz data (no threads in last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentBuzz = showBuzz.filter((t: any) => new Date(t.date) >= thirtyDaysAgo);
  if (showBuzz.length > 0 && recentBuzz.length === 0) {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'stale_data',
      message: 'No buzz threads in last 30 days - needs refresh',
      severity: 'medium',
    });
  }

  // Check total review count for confidence
  if (showReviews.length < 5 && show.status === 'open') {
    issues.push({
      showId: show.id,
      showTitle: show.title,
      type: 'low_confidence',
      message: `Only ${showReviews.length} reviews (5+ needed for medium confidence)`,
      severity: 'high',
    });
  }

  return { issues, suggestions };
}

function generateReport(): UpdateReport {
  const shows = loadJSON(SHOWS_FILE).shows;
  const reviews = loadJSON(REVIEWS_FILE).reviews;
  const audience = loadJSON(AUDIENCE_FILE).audience;
  const buzz = loadJSON(BUZZ_FILE).threads;

  const allIssues: Issue[] = [];
  const allSuggestions: Suggestion[] = [];

  for (const show of shows) {
    // Only check open shows by default
    if (show.status !== 'open') continue;

    const { issues, suggestions } = analyzeShow(show, reviews, audience, buzz);
    allIssues.push(...issues);
    allSuggestions.push(...suggestions);
  }

  // Sort issues by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    timestamp: new Date().toISOString(),
    showsChecked: shows.filter((s: any) => s.status === 'open').length,
    issues: allIssues,
    suggestions: allSuggestions,
  };
}

function printReport(report: UpdateReport) {
  console.log('\n' + '='.repeat(60));
  console.log('BROADWAY SCORECARD - DATA UPDATE REPORT');
  console.log('='.repeat(60));
  console.log(`Generated: ${report.timestamp}`);
  console.log(`Shows checked: ${report.showsChecked}`);
  console.log('');

  if (report.issues.length === 0) {
    console.log('✓ No issues found! All shows have adequate data coverage.');
  } else {
    console.log(`Found ${report.issues.length} issues:\n`);

    // Group by severity
    const highIssues = report.issues.filter(i => i.severity === 'high');
    const mediumIssues = report.issues.filter(i => i.severity === 'medium');
    const lowIssues = report.issues.filter(i => i.severity === 'low');

    if (highIssues.length > 0) {
      console.log('🔴 HIGH PRIORITY:');
      for (const issue of highIssues) {
        console.log(`   [${issue.showTitle}] ${issue.message}`);
      }
      console.log('');
    }

    if (mediumIssues.length > 0) {
      console.log('🟡 MEDIUM PRIORITY:');
      for (const issue of mediumIssues) {
        console.log(`   [${issue.showTitle}] ${issue.message}`);
      }
      console.log('');
    }

    if (lowIssues.length > 0) {
      console.log('🟢 LOW PRIORITY:');
      for (const issue of lowIssues) {
        console.log(`   [${issue.showTitle}] ${issue.message}`);
      }
      console.log('');
    }
  }

  console.log('='.repeat(60));
  console.log('NEXT STEPS:');
  console.log('1. Review issues above and gather missing data');
  console.log('2. Update JSON files in /data directory');
  console.log('3. Run `npm run build` to regenerate site');
  console.log('4. Commit and push to deploy');
  console.log('='.repeat(60) + '\n');
}

// Main execution
const report = generateReport();
printReport(report);

// Save report to file
const reportPath = path.join(DATA_DIR, 'update-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Report saved to: ${reportPath}`);
