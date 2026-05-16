#!/usr/bin/env node
/*
 * Build the WE-discovery holdout validation set (S1-T2).
 *
 * Reads existing TR-sourced review files for the holdout shows, persists a
 * fixed-truth fixture used by `scripts/lib/show-match-verifier.test.mjs`
 * (S1-T4) to guard against verifier overfitting on the probe set.
 *
 * A review is considered TR-sourced if `sources` (or legacy `source`) includes
 * a token containing "theatre-record", OR `theatreRecordUrl` is present.
 */

const fs = require('fs');
const path = require('path');

const HOLDOUT_SHOWS = [
  'operation-mincemeat-west-end-2024',
  'hadestown-west-end-2024',
];

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'we-discovery-holdout.json');

function isTRSourced(review) {
  const sources = Array.isArray(review.sources)
    ? review.sources
    : (review.source ? [review.source] : []);
  if (sources.some(s => typeof s === 'string' && s.toLowerCase().includes('theatre-record'))) {
    return true;
  }
  if (review.theatreRecordUrl) return true;
  return false;
}

function pickHoldoutFields(r) {
  return {
    outletId: r.outletId || null,
    outlet: r.outlet || null,
    criticName: r.criticName || null,
    url: r.url || null,
    publishDate: r.publishDate || null,
    textWordCount: r.textWordCount || r.wordCount || null,
    contentTier: r.contentTier || null,
    sources: Array.isArray(r.sources) ? r.sources : (r.source ? [r.source] : []),
    theatreRecordUrl: r.theatreRecordUrl || null,
    expectedValid: true,
  };
}

const holdout = {
  _meta: {
    generatedAt: new Date().toISOString(),
    purpose: 'WE-discovery verifier holdout (S1-T4 validation) — distinct from S1 probe set',
    shows: HOLDOUT_SHOWS,
    notes: 'Plan referenced sunset-boulevard-west-end-2024 + operation-mincemeat-2023, but those exact IDs do not exist in shows.json. Substituted with the closest WE catalogue entries that have TR coverage: operation-mincemeat-west-end-2024 (the WE original, 21 TR reviews) + hadestown-west-end-2024 (Lyric Theatre, 20 TR reviews). Both are distinct from the 5-show probe set (evita, hercules, the-producers, kinky-boots, inter-alia).',
  },
  shows: {},
};

for (const showId of HOLDOUT_SHOWS) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) {
    console.error(`Missing review-texts dir for ${showId}`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const reviews = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!isTRSourced(j)) continue;
      if (!j.url) continue;
      reviews.push(pickHoldoutFields(j));
    } catch (e) {
      console.error(`  parse-error ${f}: ${e.message}`);
    }
  }
  reviews.sort((a, b) => (a.outletId || '').localeCompare(b.outletId || ''));
  holdout.shows[showId] = {
    reviewCount: reviews.length,
    reviews,
  };
  console.log(`${showId}: ${reviews.length} TR-sourced reviews`);
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(holdout, null, 2));
console.log(`\nWrote ${OUT_PATH}`);
