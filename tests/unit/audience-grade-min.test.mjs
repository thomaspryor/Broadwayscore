#!/usr/bin/env node
/**
 * Guards the Audience Grade review minimum (owner decision 2026-10-31: 15 -> 10).
 * One value lives in src/config/audience-grade.json. This test fails if a script or the
 * site code goes back to its own hardcoded copy, and checks Downstate West End 2019
 * (14 Mezzanine-only reviews) now earns a grade against the real data.
 */
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const cfg = require('../../src/config/audience-grade.json');

assert.strictEqual(cfg.minReviews, 10, 'minReviews should be 10');
assert.ok(cfg.fullConfidenceReviews > cfg.minReviews, 'small-sample note threshold must sit above the minimum');

// 1. Every consumer reads the shared config, none keeps its own number.
const consumers = [
  'src/lib/audience-grade-utils.ts',
  'scripts/send-opening-digest.js',
  'scripts/generate-mobile-data.js',
  'scripts/generate-homepage-archive.js',
  'scripts/lib/generate-market-archive.js',
  'scripts/generate-fantasy-config.js',
  'scripts/compute-gold-lists.js',
  'scripts/lib/reddit-opening-post.js',
  'scripts/newsletter/generate.mjs',
];
for (const f of consumers) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.ok(/audience-grade\.json/.test(src), `${f} must read src/config/audience-grade.json`);
  assert.ok(!/MIN_AUDIENCE_REVIEWS\s*(:\s*number\s*)?=\s*\d+/.test(src), `${f} hardcodes MIN_AUDIENCE_REVIEWS`);
}

// Known non-gate uses of a bare 10/15 next to a review total (each with the reason).
const NOT_THE_GATE = {
  [['scripts', 'audit-audience-scores.js'].join('/')]: 'data-quality warning for open shows under 10 reviews, not the grade gate',
};

// 2. Sweep: no other script keeps a private copy of the audience minimum.
const strays = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && !/test/.test(e.name)) {
      const rel = path.relative(ROOT, p);
      if (consumers.includes(rel) || NOT_THE_GATE[rel]) continue;
      const src = fs.readFileSync(p, 'utf8');
      // named copy of the constant, or a bare 10/15 compared with a review total in audience code
      if (/MIN_AUDIENCE_REVIEWS\s*=\s*\d+/.test(src)) strays.push(rel);
      else if (/audience/i.test(src) && /\b(totalReviews|totalAudienceReviews|audienceReviews)\s*(<|>=|>|<=)\s*(10|15)\b/.test(src)) strays.push(rel);
    }
  }
})(path.join(ROOT, 'scripts'));
assert.deepStrictEqual(strays, [], 'private copies of MIN_AUDIENCE_REVIEWS: ' + strays.join(', '));

// 3. Real data: Downstate (14 reviews) gets a grade, a show under the minimum does not.
const buzzPath = path.join(ROOT, 'data', 'audience-buzz.json');
if (fs.existsSync(buzzPath)) {
  const shows = require(buzzPath).shows;
  const total = (b) => Object.values(b.sources || {}).reduce((a, s) => a + ((s && s.reviewCount) || 0), 0);
  const d = shows['downstate-west-end-2019'];
  assert.ok(d && total(d) >= cfg.minReviews && total(d) < cfg.fullConfidenceReviews, 'Downstate should sit in the newly graded band');
  const below = Object.values(shows).filter((b) => b.combinedScore != null && total(b) < cfg.minReviews).length;
  const newly = Object.values(shows).filter((b) => b.combinedScore != null && total(b) >= cfg.minReviews && total(b) < 15).length;
  console.log(`Downstate: ${total(d)} reviews -> graded. Still ungraded: ${below}. Newly graded (10-14): ${newly}.`);
} else {
  console.log('data/audience-buzz.json absent, skipped real-data check');
}

// 4. Suppressed / unscored sources never count toward the gate (BRO-6738). Requires the real helper.
const { countVisibleAudienceReviews } = require('../../scripts/lib/audience-review-count.js');
assert.strictEqual(countVisibleAudienceReviews({ reddit: { reviewCount: 223, score: 80, suppressed: true } }), 0);
assert.strictEqual(countVisibleAudienceReviews({ reddit: { reviewCount: 223, score: 80, suppressed: true }, showScore: { reviewCount: 6, score: 90 }, mezzanine: { reviewCount: 5, score: null } }), 6);
assert.strictEqual(countVisibleAudienceReviews(undefined), 0);
// The TS gate and every CJS consumer use the same rule.
const tsGate = fs.readFileSync(path.join(ROOT, 'src/lib/audience-grade-utils.ts'), 'utf8');
assert.ok(/source\.suppressed/.test(tsGate), 'getTotalAudienceReviews must skip suppressed sources');
for (const f of consumers.filter((c) => c.startsWith('scripts/') && !/reddit-opening-post/.test(c))) {
  assert.ok(/audience-review-count/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} must count reviews with audience-review-count.js`);
}
if (fs.existsSync(buzzPath)) {
  const bad = Object.entries(require(buzzPath).shows).filter(([, b]) => b.combinedScore != null && countVisibleAudienceReviews(b.sources) < cfg.minReviews && Object.values(b.sources || {}).some((x) => x && x.suppressed));
  console.log(`# graded in raw data but gated by visible count: ${bad.length}`);
}
console.log('audience-grade-min: PASS');
