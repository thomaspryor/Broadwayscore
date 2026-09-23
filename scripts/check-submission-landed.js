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
const { checkSubmissionLanded } = require('./lib/submission-landing');

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.match(/^--([a-z-]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
if (!args.show || !args.url) {
  console.error('Usage: node scripts/check-submission-landed.js --show=ID --url=URL');
  process.exit(2);
}

const dataDir = path.join(__dirname, '..', 'data');
const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
const show = (showsData.shows || showsData).find((s) => s.id === args.show) || null;

const result = checkSubmissionLanded({
  showId: args.show,
  url: args.url,
  reviews: reviewsData.reviews || reviewsData,
  reviewTextsDir: path.join(dataDir, 'review-texts'),
  show,
});

console.log(result.landed
  ? `✅ Landed: ${args.show} review is in reviews.json (${result.file})`
  : `❌ NOT on the site: ${result.reason}${result.file ? ` (${result.file})` : ''}`);

if (process.env.GITHUB_OUTPUT) {
  const reason = String(result.reason || '').replace(/[\r\n]+/g, ' ');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `landed=${result.landed}\nexcluded_reason=${reason}\n`);
}
