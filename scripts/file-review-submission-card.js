#!/usr/bin/env node
/**
 * Files one dispatchable Linear card for a [Review Submission] issue that
 * parked as needs-manual-review (BRO-7606; feedback twin: file-feedback-card.js).
 *
 *   node scripts/file-review-submission-card.js
 *       One issue, from process-review-submission.yml.
 *       Env: ISSUE_NUMBER, SHOW_ID, REVIEW_URL, REASON, LINEAR_API_KEY, GH_TOKEN.
 *   node scripts/file-review-submission-card.js --sweep [--max=N] [--dry-run]
 *       Backfill from rebuild-fast.yml: every open parked submission without the
 *       linear-card label (at most N per run, default 5).
 *
 * After filing (or finding the open card) it labels the issue linear-card, so
 * the sweep never asks the board again. Fail-soft: always exits 0. Never logs
 * the issue body or the card notes (public Actions log).
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);
const path = require('path');
const { execFileSync } = require('child_process');
const { exitFlushed } = require('./lib/exit-flushed.js');
const {
  fileReviewSubmissionCard, reviewSubmissionsNeedingCard, CARD_FILED_LABEL,
} = require('./lib/plan-refusal-escalation.js');

const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
// Issues touched in the last 15 min are left to the per-issue workflow step.
const SETTLE_MS = 15 * 60 * 1000;

function runLinear(args) {
  return execFileSync('node', [path.join(__dirname, 'linear-brain.js'), ...args], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The REST labels endpoint creates a missing label, so no setup step is needed.
function markFiled(issueNumber, runGh) {
  try {
    runGh(['api', '-X', 'POST', `repos/${REPO}/issues/${issueNumber}/labels`, '-f', `labels[]=${CARD_FILED_LABEL}`]);
    return true;
  } catch (e) {
    console.log(`::warning::#${issueNumber}: could not add ${CARD_FILED_LABEL} label (${String(e.message).split('\n')[0]})`);
    return false;
  }
}

function fileOne({ issueNumber, showId, reviewUrl, reason }, { run, runGh }) {
  const res = fileReviewSubmissionCard({
    issueNumber, showId, reviewUrl, reason,
    issueUrl: `https://github.com/${REPO}/issues/${issueNumber}`,
  }, { run });
  if (res.filed || res.reused) markFiled(issueNumber, runGh);
  console.log(`file-review-submission-card: #${issueNumber} ${res.filed ? 'filed' : res.reused ? 'card already open' : `not filed (${res.error})`}`);
  return res;
}

function sweep({ max = 5, dryRun = false } = {}, { run, runGh }) {
  let issues;
  try {
    const byNumber = new Map();
    for (const label of ['needs-manual-review', 'scraping-failed']) {
      const found = JSON.parse(runGh(['issue', 'list', '--repo', REPO, '--label', label, '--state', 'open', '--limit', '100', '--json', 'number,title,body,labels,updatedAt']));
      for (const issue of found) byNumber.set(issue.number, issue);
    }
    issues = [...byNumber.values()];
  } catch (e) {
    console.log(`::warning::review-submission card sweep skipped: gh issue list failed (${String(e.message).split('\n')[0]})`);
    return [];
  }
  const todo = reviewSubmissionsNeedingCard(issues, { settleMs: SETTLE_MS }).sort((a, b) => a.number - b.number);
  console.log(`file-review-submission-card: ${todo.length} parked submission(s) without a card${todo.length > max ? `, filing the first ${max}` : ''}`);
  const results = [];
  for (const issue of todo.slice(0, max)) {
    const reviewUrl = (String(issue.body).match(/### Review URL\s*\n+\s*(https?:\/\/\S+)/) || [])[1] || '';
    const parked = issue.labels.some((l) => l.name === 'scraping-failed') ? 'scraping the review failed' : 'parked as needs-manual-review';
    if (dryRun) { console.log(`  would file #${issue.number}`); continue; }
    results.push(fileOne({ issueNumber: issue.number, reviewUrl, reason: `${parked}; found by the rebuild-fast sweep (see the bot comments on the issue)` }, { run, runGh }));
  }
  return results;
}

function main(argv = process.argv.slice(2), env = process.env, deps = { run: runLinear, runGh: gh }) {
  if (argv.includes('--sweep')) {
    const maxArg = argv.find((a) => a.startsWith('--max='));
    const max = maxArg ? Math.max(0, parseInt(maxArg.slice(6), 10) || 0) : 5;
    sweep({ max, dryRun: argv.includes('--dry-run') }, deps);
    return 0;
  }
  const issueNumber = env.ISSUE_NUMBER;
  if (!/^[1-9]\d{0,6}$/.test(String(issueNumber || ''))) { console.log('file-review-submission-card: no valid ISSUE_NUMBER, nothing to do'); return 0; }
  fileOne({ issueNumber, showId: env.SHOW_ID, reviewUrl: env.REVIEW_URL, reason: env.REASON }, deps);
  return 0;
}

if (require.main === module) exitFlushed(main());
module.exports = { main, sweep };
