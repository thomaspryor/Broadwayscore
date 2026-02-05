#!/usr/bin/env node

/**
 * Bridges Formspree review submissions to GitHub Issues.
 *
 * Polls the Formspree review form for new submissions and creates
 * GitHub Issues in the format that process-review-submission.yml expects.
 * The existing pipeline then auto-validates, scrapes, and adds reviews.
 *
 * Env vars:
 *   FORMSPREE_REVIEW_TOKEN - Formspree API token for review form
 *   GITHUB_TOKEN     - GitHub token (auto-available in Actions)
 *   GITHUB_REPOSITORY - owner/repo (auto-available in Actions)
 *   DRY_RUN          - if "true", log but don't create issues
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORM_ID = 'mpqjawag';
const TRACKING_FILE = path.join(__dirname, '../data/audit/processed-review-submissions.json');
const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Load tracking data for deduplication
 */
function loadTracking() {
  try {
    return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  } catch {
    return { processedIds: [], lastChecked: null };
  }
}

/**
 * Save tracking data
 */
function saveTracking(data) {
  data.lastChecked = new Date().toISOString();
  fs.mkdirSync(path.dirname(TRACKING_FILE), { recursive: true });
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Fetch new review submissions from Formspree
 */
async function fetchSubmissions() {
  const token = process.env.FORMSPREE_REVIEW_TOKEN;
  if (!token) {
    console.log('FORMSPREE_REVIEW_TOKEN not set. Exiting.');
    return [];
  }

  // Fetch submissions from the last 48 hours (overlap to avoid missed submissions)
  const since = new Date();
  since.setHours(since.getHours() - 48);

  try {
    const res = await fetch(
      `https://formspree.io/api/0/forms/${FORM_ID}/submissions?since=${since.toISOString()}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      console.error(`Formspree API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    return data.submissions || [];
  } catch (err) {
    console.error('Error fetching from Formspree:', err.message);
    return [];
  }
}

/**
 * Extract a readable domain from a URL for issue titles
 */
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return 'unknown-source';
  }
}

/**
 * Format a Formspree submission into the GitHub Issue body
 * that validate-review-submission.js expects (matches missing-review.yml template)
 */
function formatIssueBody(sub) {
  const reviewUrl = sub.review_url || '';
  const showName = sub.show_name || '_No response_';
  const outletName = sub.outlet_name || '_No response_';
  const criticName = sub.critic_name || '_No response_';
  const notes = sub.notes || '_No response_';

  return `### Review URL\n${reviewUrl}\n\n### Show Name\n${showName}\n\n### Outlet Name\n${outletName}\n\n### Critic Name\n${criticName}\n\n### Additional Notes\n${notes}\n\n---\n*Submitted via [broadwayscorecard.com/submit-review](https://broadwayscorecard.com/submit-review)*`;
}

/**
 * Generate an issue title from submission data
 */
function formatIssueTitle(sub) {
  const outlet = sub.outlet_name || extractDomain(sub.review_url || '');
  const show = sub.show_name || 'Unknown Show';
  return `[Review Submission] ${outlet} review of ${show}`;
}

/**
 * Create a GitHub Issue via the REST API
 */
async function createGitHubIssue(title, body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

  if (!token) {
    console.error('GITHUB_TOKEN not set. Cannot create issues.');
    return null;
  }

  const [owner, repoName] = repo.split('/');

  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      body,
      labels: ['review-submission', 'needs-validation'],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`GitHub API error: ${res.status} — ${errBody}`);
    return null;
  }

  return await res.json();
}

/**
 * Trigger the Process Review Submission workflow via workflow_dispatch.
 * GITHUB_TOKEN events don't trigger other workflows (to prevent loops),
 * but workflow_dispatch is explicitly exempt from this restriction.
 */
async function triggerValidationWorkflow(issueNumber) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

  if (!token) return false;

  const [owner, repoName] = repo.split('/');

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/process-review-submission.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            issue_number: String(issueNumber),
          },
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`    Workflow dispatch failed: ${res.status} — ${errBody}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`    Workflow dispatch error: ${err.message}`);
    return false;
  }
}

/**
 * Main
 */
async function main() {
  console.log('Fetching review submissions from Formspree...\n');

  const submissions = await fetchSubmissions();
  console.log(`Fetched ${submissions.length} submission(s) from last 48h\n`);

  if (submissions.length === 0) {
    console.log('No submissions to process.');
    return;
  }

  const tracking = loadTracking();
  const processedSet = new Set(tracking.processedIds);

  let created = 0;
  let skipped = 0;
  let spam = 0;

  for (const sub of submissions) {
    const subId = sub._id || sub.id || sub.createdAt;

    // Skip already-processed
    if (processedSet.has(subId)) {
      skipped++;
      continue;
    }

    // Skip honeypot spam
    if (sub._gotcha) {
      spam++;
      processedSet.add(subId);
      tracking.processedIds.push(subId);
      console.log(`  SPAM (honeypot filled) — skipped`);
      continue;
    }

    // Skip submissions without a review URL
    if (!sub.review_url) {
      console.log(`  Missing review_url — skipped`);
      processedSet.add(subId);
      tracking.processedIds.push(subId);
      continue;
    }

    const title = formatIssueTitle(sub);
    const body = formatIssueBody(sub);

    console.log(`  ${title}`);
    console.log(`    URL: ${sub.review_url}`);

    if (DRY_RUN) {
      console.log(`    [DRY RUN] Would create issue`);
    } else {
      const issue = await createGitHubIssue(title, body);
      if (issue) {
        console.log(`    Created issue #${issue.number}`);
        created++;

        // Trigger the validation workflow via workflow_dispatch
        // (GITHUB_TOKEN issue events are suppressed, but dispatch is exempt)
        const dispatched = await triggerValidationWorkflow(issue.number);
        if (dispatched) {
          console.log(`    Dispatched validation workflow for #${issue.number}`);
        } else {
          console.log(`    Warning: Could not dispatch validation workflow`);
        }
      } else {
        console.log(`    Failed to create issue`);
        continue; // Don't mark as processed if creation failed
      }
    }

    processedSet.add(subId);
    tracking.processedIds.push(subId);
  }

  // Keep tracking list from growing indefinitely (retain last 500)
  if (tracking.processedIds.length > 500) {
    tracking.processedIds = tracking.processedIds.slice(-500);
  }

  saveTracking(tracking);

  console.log(`\nDone: ${created} created, ${skipped} already processed, ${spam} spam`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
