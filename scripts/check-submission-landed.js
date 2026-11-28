#!/usr/bin/env node
/**
 * check-submission-landed.js --show=ID --url=URL
 *
 * Run by process-review-submission.yml AFTER "Rebuild reviews.json". Prints the
 * verdict and, under GitHub Actions, writes `landed=true|false` and
 * `excluded_reason=<why>` to $GITHUB_OUTPUT so the workflow only tells the
 * submitter "Successfully Added" when the review really is in reviews.json.
 * Always exits 0 on a verdict (either way); exit 2 = bad arguments.
 */

const fs = require('fs');
const path = require('path');
const { checkSubmissionLandedAnywhere } = require('./lib/submission-landing');

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.match(/^--([a-z-]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
if (!args.show || !args.url) {
  console.error('Usage: node scripts/check-submission-landed.js --show=ID --url=URL');
  process.exit(2);
}

const dataDir = path.join(__dirname, '..', 'data');
const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
const shows = showsData.shows || showsData;
const show = shows.find((s) => s.id === args.show) || null;

// Falls back to the show that actually holds the file when the validator named
// the wrong production (issue #1178).
const result = checkSubmissionLandedAnywhere({
  showId: args.show,
  url: args.url,
  reviews: reviewsData.reviews || reviewsData,
  reviewTextsDir: path.join(dataDir, 'review-texts'),
  show,
  shows,
});
const realShow = result.actualShowId || args.show;

console.log(result.landed
  ? `✅ Landed: ${realShow} review is in reviews.json (${result.file})${result.actualShowId ? ` [submission named ${args.show}]` : ''}`
  : `❌ NOT on the site: ${result.reason}${result.file ? ` (${result.file})` : ''}`);

if (process.env.GITHUB_OUTPUT) {
  const reason = String(result.reason || '').replace(/[\r\n]+/g, ' ');
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `landed=${result.landed}\npending_score=${!!result.pendingScore}\nexcluded_reason=${reason}\nactual_show_id=${result.actualShowId || ''}\nnote=${result.actualShowId ? `review found under ${result.actualShowId}, not the submitted ${args.show}` : ''}\n`);
}
