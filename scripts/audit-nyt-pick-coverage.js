#!/usr/bin/env node
/**
 * audit-nyt-pick-coverage.js — NYT Critic's Picks with no review on file (BRO-4192).
 *
 * The Critic's Pick badge is applied by rebuild-all-reviews.js only when the
 * picked NYT review's URL is in our review data. Picks for shows we track
 * whose NYT review was never gathered get no badge. This lists every pick in
 * data/nyt-critics-picks.json that matches no stored review, with the tracked
 * show(s) it most likely belongs to.
 *
 * Candidates are a heuristic (title words vs. URL slug, publish date vs. run
 * window). Confirm each before ingesting, e.g.:
 *   node scripts/ingest-urls.js --show=<id> --urls=<file> --no-fetch
 *
 * Usage:
 *   node scripts/audit-nyt-pick-coverage.js            # human report
 *   node scripts/audit-nyt-pick-coverage.js --json     # machine-readable
 *   node scripts/audit-nyt-pick-coverage.js --fail-on-candidates
 *       exit 1 when any unmatched pick has a tracked-show candidate
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { auditPickCoverage } = require('./lib/nyt-pick-coverage');

const USAGE = fs.readFileSync(__filename, 'utf8').split('*/')[0];

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const root = path.join(__dirname, '..');
  const picks = JSON.parse(fs.readFileSync(path.join(root, 'data/nyt-critics-picks.json'), 'utf8')).urls || [];
  const reviewsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data/reviews.json'), 'utf8'));
  const showsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
  const reviews = reviewsRaw.reviews || reviewsRaw;
  const shows = showsRaw.shows || showsRaw;

  const { matched, unmatched } = auditPickCoverage(picks, reviews, shows);
  const actionable = unmatched.filter(u => u.candidates.length > 0);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ picks: picks.length, matched: matched.length, unmatched, actionable: actionable.length }, null, 2));
  } else {
    console.log(`NYT Critic's Picks on file: ${picks.length}`);
    console.log(`  matched to a stored review: ${matched.length}`);
    console.log(`  no stored review:           ${unmatched.length} (${actionable.length} with a tracked-show candidate)`);
    if (actionable.length) {
      console.log('\nPicks for tracked shows with no review on file (confirm, then ingest):');
      for (const u of actionable) {
        console.log(`\n  ${u.date}  ${u.url}`);
        for (const c of u.candidates) {
          const nyt = c.existingNytReviews.length ? ` — has other NYT review(s): ${c.existingNytReviews.join(', ')}` : '';
          console.log(`    -> ${c.showId} [${c.status}] "${c.title}"${nyt}`);
        }
      }
    }
  }
  if (argv.includes('--fail-on-candidates') && actionable.length > 0) return 1;
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
