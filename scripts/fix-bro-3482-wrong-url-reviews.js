#!/usr/bin/env node
/**
 * BRO-3482: six review records pointed at unrelated articles. Idempotent fix
 * applied to BOTH private repos (review-texts source + core-data reviews.json).
 * Usage: node scripts/fix-bro-3482-wrong-url-reviews.js [--apply]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { invalidateWrongShowAutoClear } = require('./lib/review-write-guard.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/fix-bro-3482-wrong-url-reviews.js [--apply]  (dry run without --apply)');
  process.exit(0);
}

const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts');
const REVIEWS = process.env.REVIEWS_JSON || path.join(os.homedir(), 'broadway-scorecard-data', 'reviews.json');
const NOTE = '2026-10-05 BRO-3482: ';

// file (relative to review-texts) -> patch; drop = remove record from reviews.json
const FIXES = [
  { file: 'fences-2010/timeout--adam-feldman.json', match: { showId: 'fences-2010', outletId: 'timeout', criticName: 'Adam Feldman' }, drop: true,
    patch: { url: null, originalScore: null, originalScoreNormalized: null, wrongShow: true,
      wrongShowReason: 'url was timeout.com/movies/fences (the 2016 film review); 4/5 json-ld rating belongs to the film' } },
  { file: 'les-miserables-1987/whatsonstage--unknown.json', match: { showId: 'les-miserables-1987', outletId: 'whatsonstage' }, drop: false,
    patch: { url: null, serpDiscoveryAbandoned: true, urlClearedReason: 'url was a WhatsOnStage how-Les-Mis-came-to-be retrospective, not a review; score kept (Stagedoor aggregator star)' } },
  { file: 'moulin-rouge-2019/billboard--mary-j-dimeglio.json', match: { showId: 'moulin-rouge-2019', outletId: 'billboard' }, drop: true,
    patch: { isNonReview: true, isNonReviewReason: 'Billboard cast-recording single listen article ("Sparkling Diamond"), not a review', nonReviewReason: 'Billboard cast-recording single listen article ("Sparkling Diamond"), not a review' } },
  { file: 'black-is-the-color-of-my-voice-west-end-2026/london-theatre--unknown.json', match: { showId: 'black-is-the-color-of-my-voice-west-end-2026', outletId: 'london-theatre' }, drop: true,
    patch: { url: null, wrongShow: true, wrongShowReason: 'url was londontheatre.co.uk review of Boys From the Blackstuff (National Theatre), a different production' } },
  { file: 'black-is-the-color-of-my-voice-west-end-2026/london-theatre--olivia-rook.json', match: null, drop: false,
    patch: { url: null, wrongShow: true, wrongShowReason: 'url was londontheatre.co.uk review of Boys From the Blackstuff (National Theatre), a different production' } },
];

const apply = process.argv.includes('--apply');
const rj = JSON.parse(fs.readFileSync(REVIEWS, 'utf8'));
let changed = 0;
for (const f of FIXES) {
  const p = path.join(TEXTS, f.file);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  Object.assign(d, f.patch, { manualFixNote: NOTE + (f.patch.wrongShowReason || f.patch.nonReviewReason || f.patch.urlClearedReason) });
  // A re-flag must retract any stale wrongShowAutoCleared breadcrumb (BRO-3225 / lint-autoclear-invalidate).
  if (f.patch.wrongShow === true) invalidateWrongShowAutoClear(d);
  if (apply) fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log(`${apply ? 'patched' : 'would patch'} ${f.file}`);
}
const keyMatch = (v, m) => Object.entries(m).every(([k, x]) => v[k] === x);
const before = rj.reviews.length;
rj.reviews = rj.reviews.filter((v) => !FIXES.some((f) => f.drop && f.match && keyMatch(v, f.match)));
for (const v of rj.reviews) {
  for (const f of FIXES) if (!f.drop && f.match && keyMatch(v, f.match)) { v.url = null; changed++; }
}
console.log(`reviews.json: dropped ${before - rj.reviews.length}, url-cleared ${changed}`);
if (apply) fs.writeFileSync(REVIEWS, JSON.stringify(rj, null, 2));
