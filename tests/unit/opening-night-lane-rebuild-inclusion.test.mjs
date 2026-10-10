// BRO-4806 (epic BRO-4210, BRO-4782 wiring B): the rebuild inclusion path keeps opening-night lane reviews.
// Real functions only (CLAUDE.md section 15): explainExclusion / isIncludableForRebuild / isScoreable / decideInclusion
// are driven with a lane review and the SAME review stripped of its stamp (ordinary). Lane is included; ordinary is
// excluded for exactly the reason it is today. rebuild-all-reviews.js is top-level module code that cannot be
// imported or pointed at a fixture corpus, so its inline gates are pinned by a wiring check below.
// Run: node --test tests/unit/opening-night-lane-rebuild-inclusion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const tm = require('../../scripts/lib/opening-night-lane/trust-model.js');
const guards = require('../../scripts/lib/review-guards.js');
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const { decideInclusion } = require('../../scripts/scoring-delta.js');

const SHOW = { id: 'other-desert-cities-2026', title: 'Other Desert Cities', category: 'broadway', status: 'open', openingDate: '2026-10-18', previewsStartDate: '2026-09-30' };
const FILE = '/x/nytimes--jesse-green--on-2026-10-18.json';
const laneReview = (over = {}) => tm.buildLaneReview({
  showId: SHOW.id, night: '2026-10-18', source: 'aggregator', seenAt: '2026-10-18T23:41:00Z', outletId: 'nytimes',
  outlet: 'The New York Times', criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/10/19/theater/odc-review.html',
  publishDate: '2026-10-19', fullText: 'The play lands with real force. '.repeat(20), ...over,
});
const ordinary = (r) => { const o = { ...r }; delete o.openingNightLane; delete o.productionVerified; return o; };

// flag set -> [guard name it belongs to, the reason an ordinary review gets today]
const CASES = [
  [{ wrongProduction: true }, 'wrongProduction', 'wrongProduction'],
  [{ wrongShow: true }, 'wrongProduction', 'wrongShow'],
  [{ rejectionReason: 'wrong_production' }, 'wrongProduction', 'rejectionReason'],
  [{ rejectedAt: '2026-10-19T01:00:00Z' }, 'wrongProduction', 'rejectedAt'],
  [{ rejectedBy: ['a', 'b'] }, 'wrongProduction', 'rejectedByMultipleModels'],
  [{ isNonReview: true }, 'nonReview', 'nonReview'],
  [{ contentVerification: { wrongArticle: true, confidence: 'high', isValid: false } }, 'nonReview', 'cvWrongArticleHighConfidence'],
  [{ isRoundupArticle: true }, 'roundupUrlSwap', 'isRoundupArticle'],
  [{ contentTier: 'invalid' }, 'headlineBackstop', 'contentTierInvalid'],
  [{ fullText: 'Touring production of the national tour. '.repeat(10), textFetchedAt: '2026-10-19T02:00:00Z' }, 'tourCrossMarket', 'tourContaminationInText'],
];

test('a clean lane review and its ordinary twin are both included (control)', () => {
  const lane = laneReview();
  assert.equal(guards.explainExclusion(lane, SHOW, FILE), null);
  assert.equal(guards.explainExclusion(ordinary(lane), SHOW, FILE), null);
});

for (const [flags, guard, reason] of CASES) {
  test(`${Object.keys(flags).join('+')}: lane included, ordinary excluded as "${reason}"`, () => {
    assert.ok(tm.LANE_BYPASSED_GUARDS.includes(guard));
    const lane = { ...laneReview(), ...flags };
    assert.equal(tm.laneBypasses(lane, guard), true);
    assert.equal(guards.explainExclusion(lane, SHOW, FILE), null, 'lane review must not be excluded');
    assert.equal(guards.isIncludableForRebuild(lane, SHOW, FILE), true);
    assert.equal(guards.explainExclusion(ordinary(lane), SHOW, FILE), reason, 'ordinary review excluded exactly as today');
  });
}

test('a half-stamped file (stamp or provenance alone) or a stamp copied to another show is ordinary: every guard applies', () => {
  const flagged = { ...laneReview(), wrongProduction: true };
  const noStamp = { ...flagged }; delete noStamp.productionVerified;
  const noProv = { ...flagged }; delete noProv.openingNightLane;
  assert.equal(guards.explainExclusion(noStamp, SHOW, FILE), 'wrongProduction');
  assert.equal(guards.explainExclusion(noProv, SHOW, FILE), 'wrongProduction');
  assert.equal(guards.explainExclusion({ ...flagged, showId: 'cats-2026' }, SHOW, FILE), 'wrongProduction');
  // the stamped night must be this show's opening night
  assert.equal(guards.explainExclusion(flagged, { ...SHOW, openingDate: '2026-11-01' }, FILE), 'wrongProduction');
});

test('the lane stands down for the six guards only: other exclusions still apply to a lane review', () => {
  for (const [flags, reason] of [
    [{ fabricatedEntry: true }, 'fabricatedEntry'],
    [{ wrongAttribution: true }, 'wrongAttribution'],
    [{ isSyndicatedDuplicate: true }, 'isSyndicatedDuplicate'],
    [{ scoreStatus: 'TO_BE_CALCULATED' }, 'scoreStatusToBeCalculated'],
  ]) {
    assert.equal(guards.explainExclusion({ ...laneReview(), ...flags }, SHOW, FILE), reason);
  }
});

test('isScoreable: scraper_garbage / showNotMentioned-without-excerpt exclude an ordinary review, never a lane review', () => {
  for (const flags of [{ incompleteReason: 'scraper_garbage' }, { showNotMentioned: true }]) {
    const lane = { ...laneReview(), ...flags };
    assert.equal(isScoreable(lane, SHOW, FILE), true, JSON.stringify(flags));
    assert.equal(isScoreable(ordinary(lane), SHOW, FILE), false, JSON.stringify(flags));
  }
});

test('the TS twin of is-scoreable and the parity audit call the same predicate (they cannot be imported from node:test)', () => {
  for (const f of ['scripts/llm-scoring/is-scoreable.ts', 'scripts/audit-llm-scoring-parity.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(text, /laneBypasses/, f);
    assert.match(text, /laneBypasses\(data, 'scraperGarbage'|laneOk\('scraperGarbage'\)/, `${f}: scraper_garbage gate`);
    assert.match(text, /'headlineBackstop'/, `${f}: showNotMentioned gate`);
  }
});

test('a paywalled lane review (thumb score, no text) is included and keeps its low scoreConfidence on the file', () => {
  const lane = tm.buildLaneReview({
    showId: SHOW.id, night: '2026-10-18', source: 'aggregator', seenAt: '2026-10-18T23:41:00Z', outletId: 'nytimes',
    outlet: 'The New York Times', criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/10/19/theater/odc-review.html',
    publishDate: '2026-10-19', fullText: '', aggregator: { thumb: 'Up', excerpt: 'A real force.' },
  });
  assert.equal(lane.scoreConfidence, 'low');
  assert.equal(guards.explainExclusion({ ...lane, wrongProduction: true, isNonReview: true }, SHOW, FILE), null);
});

test('scoring-delta decideInclusion (the replay mirror) agrees: lane included, ordinary excluded', () => {
  for (const [flags, , ] of CASES.filter(([f]) => !f.fullText && !f.rejectionReason && !f.rejectedAt && !f.rejectedBy)) {
    const lane = { ...laneReview(), assignedScore: 80, ...flags };
    assert.equal(decideInclusion(lane, SHOW, guards).included, true, JSON.stringify(flags));
    assert.equal(decideInclusion(ordinary(lane), SHOW, guards).included, false, JSON.stringify(flags));
  }
});

// rebuild-all-reviews.js has no importable surface (top-level pipeline, fixed data dir, writes shared data files).
// Pin that every lane-bypassed inclusion gate calls the ONE predicate and none re-derives the stamp.
test('rebuild-all-reviews.js: each lane-bypassed inline gate calls laneOk(<guard>), and nothing re-derives the stamp', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /const \{ laneBypasses \} = require\('\.\/lib\/opening-night-lane\/trust-model'\)/);
  const GATES = {
    skippedWrongProduction: 'wrongProduction', skippedCrossShowUrl: 'wrongProduction', skippedUrlYearMismatch: 'wrongProduction', skippedUrlYearStandalone: 'wrongProduction', skippedDirectorMismatch: 'wrongProduction', skippedWrongShow: 'wrongProduction', skippedRejectionReason: 'wrongProduction',
    skippedLlmRejected: 'wrongProduction', skippedRejectedAt: 'wrongProduction',
    skippedNotReview: 'nonReview', skippedNonReview: 'nonReview', skippedWrongContent: 'nonReview',
    skippedScraperGarbage: 'scraperGarbage', skippedShowNotMentioned: 'headlineBackstop', skippedRoundup: 'roundupUrlSwap',
    crossMarketNullUrlRelay: 'tourCrossMarket', skippedCrossMarket: 'tourCrossMarket', skippedUrlPathCrossMarket: 'tourCrossMarket',
    skippedTourContamination: 'tourCrossMarket', skippedFilmTvContamination: 'tourCrossMarket',
  };
  for (const [site, guard] of Object.entries(GATES)) {
    const idxs = [...src.matchAll(new RegExp(`logExclusion\\("${site}"`, 'g'))].map((m) => m.index);
    assert.ok(idxs.length > 0, `${site} gate exists`);
    for (const i of idxs) {
      // the gate's condition sits within the ~7000 chars before its logExclusion (the nearest laneOk call of the right name)
      const before = src.slice(Math.max(0, i - 7000), i);
      assert.ok(before.includes(`laneOk('${guard}')`), `${site}: no laneOk('${guard}') in its condition`);
    }
  }
  // CV promotion and the OB-transfer sweep PERSIST wrongProduction/wrongShow/isNonReview flags to disk: never onto a lane file.
  const promotionGuards = src.match(/laneBypasses\((?:data|d), 'wrongProduction', \{ openingDate/g) || [];
  assert.ok(promotionGuards.length >= 3, `CV pre-pass, CV main loop and OB-transfer sweep must skip lane files (found ${promotionGuards.length})`);
  // Per-guard minimum call counts, so a gate that loses its own bypass is caught even when a neighbour still has one.
  const MIN_CALLS = { wrongProduction: 9, nonReview: 3, scraperGarbage: 2, headlineBackstop: 1, roundupUrlSwap: 3, tourCrossMarket: 5 };
  for (const [guard, min] of Object.entries(MIN_CALLS)) {
    const n = (src.match(new RegExp(`laneOk\\('${guard}'\\)`, 'g')) || []).length;
    assert.ok(n >= min, `laneOk('${guard}') called ${n}x, expected >= ${min}`);
  }
  assert.match(src, /laneOk\('scraperGarbage'\) && data\.scoreConfidence === 'low' \? \{ scoreConfidence: 'low' \}/, 'low confidence carried onto the row');
  for (const f of ['scripts/rebuild-all-reviews.js', 'scripts/lib/review-guards.js', 'scripts/lib/is-scoreable.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/productionVerified\s*[=!]==?|openingNightLane\b(?!')/.test(text.replace(/\/\/.*$/gm, '')), `${f} re-derives the lane stamp instead of calling laneBypasses`);
  }
});
