#!/usr/bin/env node
/**
 * build-cross-production-classify-input.js
 *
 * Adapter: turns the AMBIGUOUS bucket of data/audit/cross-production-audit.json
 * (no parseable date, no URL-year match, no venue match, closerTo:null — the
 * audit deliberately doesn't claim these) into the results[] input schema that
 * scripts/classify-wrong-production.js already consumes, so the existing,
 * battle-tested LLM classifier (Opus-advisor, in-window/concrete-different-
 * production guards, checkpoint/concurrency/apply) can verify each review by
 * reading its content and deciding which production it actually belongs to.
 *
 * Output: data/audit/cross-production-classify-input.json  ({results:[...]})
 * Then run:
 *   node scripts/classify-wrong-production.js \
 *     --audit=data/audit/cross-production-classify-input.json \
 *     --output=data/audit/cross-production-classified.json \
 *     --checkpoint=data/audit/.classify-xprod-checkpoint.json \
 *     --provider=claude --concurrency=8 [--limit=5] [--apply]
 *
 * Only items whose review file has fullText >= MIN_TEXT chars are included —
 * stubs (no body) can't be LLM-classified and the classifier would skip them
 * anyway. Pass --min-text=N to override (default 500).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const MIN_TEXT = parseInt((ARGS.find(a => a.startsWith('--min-text=')) || '').split('=')[1], 10) || 500;

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_PATH = path.join(DATA_DIR, 'audit', 'cross-production-audit.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const OUT_PATH = path.join(DATA_DIR, 'audit', 'cross-production-classify-input.json');

if (!fs.existsSync(AUDIT_PATH)) {
  console.error(`ERROR: ${AUDIT_PATH} not found — run: node scripts/audit-cross-production.js`);
  process.exit(1);
}

const shows = require(path.join(DATA_DIR, 'shows.json')).shows;
const showById = new Map(shows.map(s => [s.id, s]));
const yearOf = (s) => (s && s.openingDate ? new Date(s.openingDate).getUTCFullYear() : null);

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
const ambiguous = (audit.issues || []).filter(i => i.matchReason === 'ambiguous');

let skippedNoText = 0, skippedMissing = 0, skippedNoShow = 0;
const results = [];

for (const issue of ambiguous) {
  const showId = issue.filedUnder;
  // issue.file is "<showId>/<basename>"; the classifier joins showId + file
  // (basename), so strip the leading show-id directory.
  const file = issue.file.startsWith(showId + '/')
    ? issue.file.slice(showId.length + 1)
    : path.basename(issue.file);

  const show = showById.get(showId);
  if (!show) { skippedNoShow++; continue; }

  const filePath = path.join(REVIEW_TEXTS_DIR, showId, file);
  if (!fs.existsSync(filePath)) { skippedMissing++; continue; }

  let review;
  try { review = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { skippedMissing++; continue; }

  const text = String(review.fullText || review.bwwExcerpt || review.dtliExcerpt
    || review.showScoreExcerpt || review.pullQuote || '');
  if (text.trim().length < MIN_TEXT) { skippedNoText++; continue; }

  results.push({
    showId,
    file,
    showTitle: show.title,
    showYear: yearOf(show),
    outlet: review.outlet || review.outletId || null,
    criticName: review.criticName || null,
    publishDate: review.publishDate || null,
    confidence: 'medium',  // the classifier processes results[] where confidence === 'medium'
    signals: ['cross-production-ambiguous', `matchReason:${issue.matchReason}`,
      issue.urlYear != null ? `urlYear:${issue.urlYear}` : 'no-url-year',
      'no-venue-match', 'no-parseable-publish-date'],
  });
}

const out = {
  generatedAt: audit.timestamp || null,
  source: 'cross-production-audit.json#ambiguous',
  minText: MIN_TEXT,
  totalAmbiguous: ambiguous.length,
  included: results.length,
  skipped: { noText: skippedNoText, missing: skippedMissing, noShow: skippedNoShow },
  results,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');

console.log(`Ambiguous items: ${ambiguous.length}`);
console.log(`Included (fullText >= ${MIN_TEXT}): ${results.length}`);
console.log(`Skipped — no/short text: ${skippedNoText}, missing file: ${skippedMissing}, unknown show: ${skippedNoShow}`);
console.log(`Distinct shows: ${new Set(results.map(r => r.showId)).size}`);
console.log(`Wrote ${path.relative(path.join(__dirname, '..'), OUT_PATH)}`);
