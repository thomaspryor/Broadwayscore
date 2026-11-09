#!/usr/bin/env node
// LIVE-DATA-LANE: reads data/audience-buzz.json (read by the test); data/shows.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// TESTS-VS-DERIVED-DATA-EXEMPT: Show metadata is input to scoring/count parity; no metadata values are pinned.
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
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const cfg = require('../../src/config/audience-grade.json');
const { countVisibleAudienceReviews } = require('../../scripts/lib/audience-review-count.js');

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
  const showInfo = new Map(require('../../data/shows.json').shows.map(s => [s.id, s]));
  const total = ([id, b]) => countVisibleAudienceReviews(b.sources, showInfo.get(id));
  const d = shows['downstate-west-end-2019'];
  const downstateCount = d && total(['downstate-west-end-2019', d]);
  assert.ok(downstateCount >= cfg.minReviews && downstateCount < cfg.fullConfidenceReviews, 'Downstate should sit in the newly graded band');
  const below = Object.entries(shows).filter((entry) => entry[1].combinedScore != null && total(entry) < cfg.minReviews).length;
  const newly = Object.entries(shows).filter((entry) => entry[1].combinedScore != null && total(entry) >= cfg.minReviews && total(entry) < cfg.fullConfidenceReviews).length;
  console.log(`Downstate: ${downstateCount} reviews -> graded. Still ungraded: ${below}. Newly graded (10-14): ${newly}.`);
} else {
  console.log('data/audience-buzz.json absent, skipped real-data check');
}

// 4. Suppressed / unscored sources never count toward the gate (BRO-6738). Requires the real helper.
assert.strictEqual(countVisibleAudienceReviews({ reddit: { reviewCount: 223, score: 80, suppressed: true } }), 0);
assert.strictEqual(countVisibleAudienceReviews({ reddit: { reviewCount: 223, score: 80, suppressed: true }, showScore: { reviewCount: 6, score: 90 }, mezzanine: { reviewCount: 5, score: null } }), 6);
assert.strictEqual(countVisibleAudienceReviews(undefined), 0);
// The TS gate and every CJS consumer use the same rule.
const tsGate = fs.readFileSync(path.join(ROOT, 'src/lib/audience-grade-utils.ts'), 'utf8');
assert.ok(/isSourceActive\(name, source, showInfo\)/.test(tsGate), 'getTotalAudienceReviews must use scoring eligibility');
for (const f of consumers.filter((c) => c.startsWith('scripts/') && !/reddit-opening-post/.test(c))) {
  assert.ok(/audience-review-count/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} must count reviews with audience-review-count.js`);
}
if (fs.existsSync(buzzPath)) {
  const bad = Object.entries(require(buzzPath).shows).filter(([, b]) => b.combinedScore != null && countVisibleAudienceReviews(b.sources) < cfg.minReviews && Object.values(b.sources || {}).some((x) => x && x.suppressed));
  console.log(`# graded in raw data but gated by visible count: ${bad.length}`);
}
console.log('audience-grade-min: PASS');

// BRO-6750: exercise the production CJS and TS functions, including exact floors.
const { isSourceActive, calculateCombinedScore } = require('../../scripts/lib/audience-weighting.js');
const { require: requireTS } = require('tsx/cjs/api');
const { getTotalAudienceReviews, hasEnoughAudienceReviews, hasFullConfidenceAudienceReviews } = requireTS('../../src/lib/audience-grade-utils.ts', import.meta.url);

test('review gates share scoring eligibility for volume, market, suppression and recency', () => {
  const cases = [
    ['theatr', { score: 100, reviewCount: 9 }, {}, false],
    ['theatr', { score: 100, reviewCount: 10 }, {}, true],
    ['reddit', { score: 80, reviewCount: 49 }, {}, false],
    ['reddit', { score: 80, reviewCount: 50 }, {}, true],
    ['reddit', { score: 80, reviewCount: 50 }, { category: 'tour' }, false],
    ['reddit', { score: 80, reviewCount: 50 }, { category: 'regional' }, true],
    ['reddit', { score: 80, reviewCount: 50 }, { status: 'closed', closingDate: '2000-01-01' }, false],
    ['reddit', { score: 80, reviewCount: 50 }, { status: 'open', closingDate: '2000-01-01' }, true],
    ...['west-end', 'off-west-end', 'tour', 'regional'].map(category =>
      ['broadwayCom', { score: 80, reviewCount: 50 }, { category }, false]),
    ...['broadway', 'off-broadway', undefined].map(category =>
      ['broadwayCom', { score: 80, reviewCount: 50 }, { category }, true]),
    ...['showScore', 'mezzanine', 'seatplan', 'lbo', 'ltd'].flatMap(name => [
      [name, { score: 0, reviewCount: 1 }, {}, true],
      [name, { score: 80, reviewCount: 0 }, {}, false],
      [name, { score: null, reviewCount: 50 }, {}, false],
      [name, { score: 80, reviewCount: 50, suppressed: true }, {}, false],
    ]),
    ['reddit', { score: 80, reviewCount: 50, suppressed: true }, {}, false],
    ['theatr', { score: 80, reviewCount: 50, suppressed: true }, {}, false],
    ['broadwayCom', null, {}, false],
    ['unknown', { score: 80, reviewCount: 50 }, {}, false],
  ];
  for (const [name, source, showInfo, active] of cases) {
    const sources = { [name]: source };
    const context = `${name}: ${JSON.stringify({ source, showInfo })}`;
    assert.equal(isSourceActive(name, source, showInfo), active, context);
    assert.equal(calculateCombinedScore(sources, showInfo).score != null, active, context);
    const count = active ? source.reviewCount : 0;
    assert.equal(countVisibleAudienceReviews(sources, showInfo), count, context);
    assert.equal(getTotalAudienceReviews({ sources }, showInfo), count, context);
    const buzz = { sources, showInfo };
    assert.equal(getTotalAudienceReviews(buzz), count, context);
    assert.equal(hasEnoughAudienceReviews(buzz), count >= cfg.minReviews, context);
    assert.equal(hasFullConfidenceAudienceReviews(buzz), count >= cfg.fullConfidenceReviews, context);
  }
});

test('excluded sources cannot lift a small sample over the grade or ranking floor', () => {
  for (const count of [9, 10, 14, 15]) {
    const sources = {
      mezzanine: { score: 80, reviewCount: count },
      theatr: { score: 100, reviewCount: 9 },
      reddit: { score: 80, reviewCount: 49 },
      broadwayCom: { score: 80, reviewCount: 500 },
    };
    const showInfo = { category: 'west-end' };
    assert.equal(countVisibleAudienceReviews(sources, showInfo), count);
    assert.equal(getTotalAudienceReviews({ sources, showInfo }), count);
    assert.equal(hasEnoughAudienceReviews({ sources, showInfo }), count >= cfg.minReviews);
    assert.equal(hasFullConfidenceAudienceReviews({ sources, showInfo }), count >= cfg.fullConfidenceReviews);
  }
});

test('real audience records count exactly the sources scoring accepts in CJS and TS', { skip: !fs.existsSync(buzzPath) }, () => {
  const shows = new Map(require('../../data/shows.json').shows.map(s => [s.id, s]));
  const { getAudienceBuzz } = requireTS('../../src/lib/data-audience.ts', import.meta.url);
  let checked = 0;
  for (const [id, buzz] of Object.entries(require(buzzPath).shows)) {
    const showInfo = shows.get(id);
    // Ask scoring about each source independently, without copying eligibility rules.
    const expected = Object.entries(buzz.sources || {}).reduce((total, [name, source]) =>
      total + (calculateCombinedScore({ [name]: source }, showInfo).score != null ? source.reviewCount : 0), 0);
    assert.equal(countVisibleAudienceReviews(buzz.sources, showInfo), expected, id);
    assert.equal(getTotalAudienceReviews(buzz, showInfo), expected, id);
    assert.equal(getTotalAudienceReviews(getAudienceBuzz(id)), expected, `${id}: server context`);
    checked++;
  }
  console.log(`Scoring/count/server-context parity: ${checked} real audience records`);
});
