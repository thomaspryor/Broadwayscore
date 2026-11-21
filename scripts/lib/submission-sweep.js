/** Reconcile review submissions after rebuild-fast publishes reviews.json. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  checkSubmissionLanded, decideAwaitingSubmission, findShowForSubmission, AWAITING_SCORE_MAX_HOURS,
} = require('./submission-landing');

// Every label that parks a submission waiting on its review to land.
// `scraping-failed` alone (older runs, or a manual label edit) must be swept
// too, or the issue stays open forever after the review lands (BRO-7614, #1062).
const QUEUE_LABELS = ['awaiting-score', 'needs-manual-review', 'scraping-failed'];
// Issues a run left with no queue label (died after validated+approved, BRO-7625)
// are only swept once older than this, so in-flight runs are never touched.
const UNLABELED_MIN_HOURS = 6;
const MANUAL_LABELS = ['needs-manual-review', 'scraping-failed'];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sweepSubmissions({ runGh = gh, closeCard = null, dryRun = false, root = path.join(__dirname, '..', '..', 'data') } = {}) {
  let issues;
  try {
    const byNumber = new Map();
    for (const label of QUEUE_LABELS) {
      const found = JSON.parse(runGh(['issue', 'list', '--label', label, '--state', 'open', '--limit', '100', '--json', 'number,title,body,createdAt,labels']));
      for (const issue of found) byNumber.set(issue.number, issue);
    }
    // Unlabeled stragglers (BRO-7625). Separate try so a failure here never skips the queue-label sweep.
    try {
      const sub = JSON.parse(runGh(['issue', 'list', '--label', 'review-submission', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,createdAt,labels']));
      for (const issue of sub) if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
    } catch (e) {
      console.log(`::warning::unlabeled review-submission list failed (${e.message.split('\n')[0]})`);
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
    const hasQueueLabel = issue.labels.some(l => QUEUE_LABELS.includes(l.name));
    const ageHours = (Date.now() - Date.parse(issue.createdAt)) / 3600e3;
    if (!hasQueueLabel && ageHours < UNLABELED_MIN_HOURS) continue;
    // Unlabeled issues get manualReview semantics: close if landed, never relabel/comment otherwise.
    const manualReview = !hasQueueLabel || issue.labels.some(l => MANUAL_LABELS.includes(l.name));
    const url = (String(issue.body).match(/### Review URL\s*\n+\s*(https?:\/\/\S+)/) || [])[1];
    const show = url ? findShowForSubmission(url, shows, textsDir) : null;
    const landed = !!(show && checkSubmissionLanded({ showId: show.id, url, reviews, reviewTextsDir: textsDir, show }).landed);
    const action = decideAwaitingSubmission({ landed, ageHours, manualReview });
    if (!hasQueueLabel && !landed) console.log(`::notice::#${issue.number} has no queue label and is not live (age ${ageHours.toFixed(1)}h); left open`);
    console.log(`#${issue.number} ${show ? show.id : '(no review file found)'} age=${ageHours.toFixed(1)}h -> ${action}`);
    if (dryRun || action === 'wait') continue;
    const n = String(issue.number);
    try {
      if (action === 'close') {
        runGh(['issue', 'comment', n, '--body', 'This review is now live on the site. Thank you for your contribution to Broadway Scorecard! 🎭']);
        // Close before removing queue labels so a failed close is retried.
        runGh(['issue', 'close', n, '--reason', 'completed']);
        const labels = issue.labels.filter(l => QUEUE_LABELS.includes(l.name));
        if (labels.length) runGh(['issue', 'edit', n, ...labels.flatMap(l => ['--remove-label', l.name])]);
        // The parked-submission card (file-review-submission-card.js) would
        // otherwise stay open on the board after the issue is closed.
        if (closeCard) {
          const res = closeCard({ issueNumber: n });
          if (res.closed) console.log(`#${n} card ${res.identifier} closed`);
          else if (res.reason !== 'no open card') console.log(`::warning::#${n} card not closed (${res.reason})`);
        }
      } else {
        runGh(['issue', 'comment', n, '--body', `Still not on the site after ${AWAITING_SCORE_MAX_HOURS}h: the review was never scored. Flagged for a maintainer.`]);
        runGh(['issue', 'edit', n, '--remove-label', 'awaiting-score', '--add-label', 'needs-manual-review']);
      }
    } catch (e) {
      console.log(`::warning::#${n} ${action} failed: ${e.message.split('\n')[0]}`);
    }
  }
}

module.exports = { sweepSubmissions, QUEUE_LABELS };
