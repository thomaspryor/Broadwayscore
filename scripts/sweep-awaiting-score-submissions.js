#!/usr/bin/env node
/**
 * sweep-awaiting-score-submissions.js [--dry-run]
 *
 * BRO-4141. process-review-submission.yml labels a submission `awaiting-score`
 * when its review was ingested but not yet scored, instead of emailing the
 * owner "not on the site" (all 11 such emails on 9/23-9/24 went live on their
 * own ~45 min later). This sweep, run by rebuild-fast.yml after each rebuild:
 *   - closes the issue once the review is in reviews.json
 *   - after AWAITING_SCORE_MAX_HOURS, relabels it `needs-manual-review`, which
 *     health-check.js already surfaces in the morning digest (no email)
 *
 * Uses the gh CLI with GH_TOKEN. rebuild-fast passes GH_DISPATCH_TOKEN, the
 * owner PAT that opened the issues, so the owner isn't emailed about closes.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  checkSubmissionLanded, decideAwaitingSubmission, findShowForSubmission, AWAITING_SCORE_MAX_HOURS,
} = require('./lib/submission-landing');

const DRY = process.argv.includes('--dry-run');
const dataDir = path.join(__dirname, '..', 'data');
const reviewTextsDir = path.join(dataDir, 'review-texts');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  let issues;
  try {
    issues = JSON.parse(gh(['issue', 'list', '--label', 'awaiting-score', '--state', 'open', '--limit', '100', '--json', 'number,body,createdAt']));
  } catch (e) {
    console.log(`::warning::awaiting-score sweep skipped: gh issue list failed (${e.message.split('\n')[0]})`);
    return;
  }
  if (!issues.length) { console.log('No awaiting-score submissions.'); return; }

  const reviews = (d => d.reviews || d)(JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8')));
  const shows = (d => d.shows || d)(JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8')));

  for (const issue of issues) {
    const url = (String(issue.body).match(/### Review URL\s*\n+\s*(https?:\/\/\S+)/) || [])[1];
    const show = url ? findShowForSubmission(url, shows, reviewTextsDir) : null;
    const landed = !!(show && checkSubmissionLanded({ showId: show.id, url, reviews, reviewTextsDir, show }).landed);
    const ageHours = (Date.now() - Date.parse(issue.createdAt)) / 3600e3;
    const action = decideAwaitingSubmission({ landed, ageHours });
    console.log(`#${issue.number} ${show ? show.id : '(no review file found)'} age=${ageHours.toFixed(1)}h -> ${action}`);
    if (DRY || action === 'wait') continue;
    const n = String(issue.number);
    try {
      if (action === 'close') {
        gh(['issue', 'comment', n, '--body', 'This review is now live on the site. Thank you for your contribution to Broadway Scorecard! 🎭']);
        gh(['issue', 'edit', n, '--remove-label', 'awaiting-score']);
        gh(['issue', 'close', n, '--reason', 'completed']);
      } else {
        gh(['issue', 'comment', n, '--body', `Still not on the site after ${AWAITING_SCORE_MAX_HOURS}h: the review was never scored. Flagged for a maintainer.`]);
        gh(['issue', 'edit', n, '--remove-label', 'awaiting-score', '--add-label', 'needs-manual-review']);
      }
    } catch (e) {
      console.log(`::warning::#${n} ${action} failed: ${e.message.split('\n')[0]}`);
    }
  }
}

main();
