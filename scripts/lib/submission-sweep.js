/** Reconcile review submissions after rebuild-fast publishes reviews.json. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  checkSubmissionLanded, decideAwaitingSubmission, findShowForSubmission, AWAITING_SCORE_MAX_HOURS,
} = require('./submission-landing');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sweepSubmissions({ runGh = gh, dryRun = false, root = path.join(__dirname, '..', '..', 'data') } = {}) {
  let issues;
  try {
    const byNumber = new Map();
    for (const label of ['awaiting-score', 'needs-manual-review']) {
      const found = JSON.parse(runGh(['issue', 'list', '--label', label, '--state', 'open', '--limit', '100', '--json', 'number,title,body,createdAt,labels']));
      for (const issue of found) byNumber.set(issue.number, issue);
    }
    issues = [...byNumber.values()];
  } catch (e) {
    console.log(`::warning::awaiting-score sweep skipped: gh issue list failed (${e.message.split('\n')[0]})`);
    return;
  }
  if (!issues.length) { console.log('No pending review submissions.'); return; }

  const reviews = (d => d.reviews || d)(JSON.parse(fs.readFileSync(path.join(root, 'reviews.json'), 'utf8')));
  const shows = (d => d.shows || d)(JSON.parse(fs.readFileSync(path.join(root, 'shows.json'), 'utf8')));
  const textsDir = path.join(root, 'review-texts');

  for (const issue of issues) {
    // The manual queue also contains bug reports and score disputes. A URL
    // already on the site says nothing about whether those reports are fixed.
    if (!String(issue.title).startsWith('[Review Submission]')) continue;
    const manualReview = issue.labels.some(l => l.name === 'needs-manual-review');
    const url = (String(issue.body).match(/### Review URL\s*\n+\s*(https?:\/\/\S+)/) || [])[1];
    const show = url ? findShowForSubmission(url, shows, textsDir) : null;
    const landed = !!(show && checkSubmissionLanded({ showId: show.id, url, reviews, reviewTextsDir: textsDir, show }).landed);
    const ageHours = (Date.now() - Date.parse(issue.createdAt)) / 3600e3;
    const action = decideAwaitingSubmission({ landed, ageHours, manualReview });
    console.log(`#${issue.number} ${show ? show.id : '(no review file found)'} age=${ageHours.toFixed(1)}h -> ${action}`);
    if (dryRun || action === 'wait') continue;
    const n = String(issue.number);
    try {
      if (action === 'close') {
        runGh(['issue', 'comment', n, '--body', 'This review is now live on the site. Thank you for your contribution to Broadway Scorecard! 🎭']);
        // Close before removing queue labels so a failed close is retried.
        runGh(['issue', 'close', n, '--reason', 'completed']);
        const labels = issue.labels.filter(l => ['awaiting-score', 'needs-manual-review'].includes(l.name));
        runGh(['issue', 'edit', n, ...labels.flatMap(l => ['--remove-label', l.name])]);
      } else {
        runGh(['issue', 'comment', n, '--body', `Still not on the site after ${AWAITING_SCORE_MAX_HOURS}h: the review was never scored. Flagged for a maintainer.`]);
        runGh(['issue', 'edit', n, '--remove-label', 'awaiting-score', '--add-label', 'needs-manual-review']);
      }
    } catch (e) {
      console.log(`::warning::#${n} ${action} failed: ${e.message.split('\n')[0]}`);
    }
  }
}

module.exports = { sweepSubmissions };
