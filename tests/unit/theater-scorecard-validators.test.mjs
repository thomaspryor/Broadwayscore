/**
 * Unit tests for theater-scorecard-validators.js
 * Uses node:test API — run with: node --test tests/unit/theater-scorecard-validators.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  validateScoreRange,
  validateSummary,
  validateScoreSummaryConsistency,
  detectBoilerplatePhrases,
  checkScoreDistribution,
  validateVenueScores,
  SCORE_DIMENSIONS,
  SUMMARY_MAX_CHARS,
} = require('../../scripts/lib/theater-scorecard-validators');

// ─── validateScoreRange ─────────────────────────────────────────────────────

test('validateScoreRange: clean scores pass', () => {
  const vs = { sightlines: 4, sound: 3, comfort: 2, ambiance: 5, facilities: 3, summary: 'ok' };
  assert.deepEqual(validateScoreRange('Test Theatre', vs), []);
});

test('validateScoreRange: missing dimension is a finding', () => {
  const vs = { sightlines: 4, sound: 3, comfort: 2, ambiance: 5 }; // missing facilities
  const findings = validateScoreRange('Test Theatre', vs);
  assert.ok(findings.some(f => f.field === 'facilities' && f.type === 'missing-dimension'));
});

test('validateScoreRange: score=0 is out of range', () => {
  const vs = { sightlines: 0, sound: 3, comfort: 2, ambiance: 5, facilities: 3 };
  const findings = validateScoreRange('Test Theatre', vs);
  assert.ok(findings.some(f => f.field === 'sightlines' && f.type === 'score-out-of-range'));
});

test('validateScoreRange: score=6 is out of range', () => {
  const vs = { sightlines: 6, sound: 3, comfort: 2, ambiance: 5, facilities: 3 };
  const findings = validateScoreRange('Test Theatre', vs);
  assert.ok(findings.some(f => f.field === 'sightlines' && f.type === 'score-out-of-range'));
});

test('validateScoreRange: float score is out of range', () => {
  const vs = { sightlines: 3.5, sound: 3, comfort: 2, ambiance: 5, facilities: 3 };
  const findings = validateScoreRange('Test Theatre', vs);
  assert.ok(findings.some(f => f.field === 'sightlines'));
});

test('validateScoreRange: null venueScores returns missing-scores finding', () => {
  const findings = validateScoreRange('Test Theatre', null);
  assert.ok(findings.some(f => f.type === 'missing-scores'));
});

// ─── validateSummary ────────────────────────────────────────────────────────

test('validateSummary: clean summary passes', () => {
  const summary = 'Great sightlines and comfortable seats. Restrooms can get crowded at intermission.';
  assert.deepEqual(validateSummary('Test Theatre', summary), []);
});

test('validateSummary: missing summary is a finding', () => {
  const findings = validateSummary('Test Theatre', undefined);
  assert.ok(findings.some(f => f.type === 'missing-summary'));
});

test('validateSummary: empty summary is a finding', () => {
  const findings = validateSummary('Test Theatre', '');
  assert.ok(findings.some(f => f.type === 'missing-summary'));
});

test('validateSummary: summary exceeding max chars is a finding', () => {
  const long = 'A'.repeat(SUMMARY_MAX_CHARS + 1);
  const findings = validateSummary('Test Theatre', long);
  assert.ok(findings.some(f => f.type === 'summary-too-long'));
});

test('validateSummary: summary over warn threshold but under max is a warning', () => {
  const medium = 'A'.repeat(450); // between WARN (400) and MAX (500)
  const findings = validateSummary('Test Theatre', medium);
  assert.ok(findings.some(f => f.type === 'summary-long-warning'));
  assert.ok(!findings.some(f => f.type === 'summary-too-long'));
});

test('validateSummary: elevator claim is banned (Todd Haimes incident)', () => {
  const summary = 'Completed renovation with elevator access to all levels.';
  const findings = validateSummary('Todd Haimes Theatre', summary);
  assert.ok(findings.some(f => f.type === 'banned-claim' && f.category === 'accessibility'));
});

test('validateSummary: wheelchair accessible claim is banned', () => {
  const summary = 'The theater is wheelchair accessible and has great sightlines.';
  const findings = validateSummary('Test Theatre', summary);
  assert.ok(findings.some(f => f.type === 'banned-claim' && f.category === 'accessibility'));
});

test('validateSummary: hearing loop claim is banned', () => {
  const summary = 'Excellent sound and a hearing loop is available throughout.';
  const findings = validateSummary('Test Theatre', summary);
  assert.ok(findings.some(f => f.type === 'banned-claim'));
});

test('validateSummary: most accessible claim is banned', () => {
  const summary = 'One of Broadway\'s most accessible and comfortable houses.';
  const findings = validateSummary('Test Theatre', summary);
  assert.ok(findings.some(f => f.type === 'banned-claim' && f.category === 'accessibility'));
});

test('validateSummary: currently playing reference is flagged', () => {
  const summary = 'The theater is currently playing a hit musical with great sound.';
  const findings = validateSummary('Test Theatre', summary);
  assert.ok(findings.some(f => f.type === 'show-reference'));
});

test('validateSummary: "production" alone does NOT trigger show-reference', () => {
  // "great for productions" is valid venue language
  const summary = 'Excellent sightlines, making it a great venue for large-scale productions.';
  const findings = validateSummary('Test Theatre', summary);
  assert.ok(!findings.some(f => f.type === 'show-reference'));
});

// ─── validateScoreSummaryConsistency ────────────────────────────────────────

test('validateScoreSummaryConsistency: clean — no conflict', () => {
  const vs = {
    comfort: 2,
    sightlines: 4,
    summary: 'Tight legroom but excellent sightlines and great sound.',
  };
  assert.deepEqual(validateScoreSummaryConsistency('Test Theatre', vs), []);
});

test('validateScoreSummaryConsistency: comfort=2 with "spacious seating" is a conflict', () => {
  const vs = { comfort: 2, sightlines: 3, summary: 'Spacious seating and great sightlines.' };
  const findings = validateScoreSummaryConsistency('Test Theatre', vs);
  assert.ok(findings.some(f => f.type === 'score-summary-conflict' && f.field === 'comfort'));
});

test('validateScoreSummaryConsistency: comfort=4 with "cramped" is a conflict', () => {
  const vs = { comfort: 4, sightlines: 4, summary: 'Cramped seating and mediocre sound.' };
  const findings = validateScoreSummaryConsistency('Test Theatre', vs);
  assert.ok(findings.some(f => f.type === 'score-summary-conflict' && f.field === 'comfort'));
});

test('validateScoreSummaryConsistency: comfort=2 with "notoriously tight" is NOT a conflict', () => {
  // Negative language is consistent with low score
  const vs = { comfort: 2, sightlines: 3, summary: 'Notoriously tight legroom throughout the house.' };
  assert.deepEqual(validateScoreSummaryConsistency('Test Theatre', vs), []);
});

test('validateScoreSummaryConsistency: sightlines=2 with "excellent sightlines" is a conflict', () => {
  const vs = { comfort: 3, sightlines: 2, summary: 'Excellent sightlines but uncomfortable seats.' };
  const findings = validateScoreSummaryConsistency('Test Theatre', vs);
  assert.ok(findings.some(f => f.type === 'score-summary-conflict' && f.field === 'sightlines'));
});

test('validateScoreSummaryConsistency: no summary returns no findings', () => {
  const vs = { comfort: 2, sightlines: 4 };
  assert.deepEqual(validateScoreSummaryConsistency('Test Theatre', vs), []);
});

// ─── detectBoilerplatePhrases ───────────────────────────────────────────────

test('detectBoilerplatePhrases: no boilerplate — clean', () => {
  const theaters = {
    'A Theatre': { summary: 'Unique description with great legroom.' },
    'B Theatre': { summary: 'Another unique description about sound.' },
    'C Theatre': { summary: 'Third unique description about ambiance.' },
  };
  assert.deepEqual(detectBoilerplatePhrases(theaters), []);
});

test('detectBoilerplatePhrases: phrase in 3+ theaters triggers warning', () => {
  const theaters = {
    'A Theatre': { summary: 'The theater offers generally good sightlines from most seats.' },
    'B Theatre': { summary: 'This venue offers generally good sightlines but tight legroom.' },
    'C Theatre': { summary: 'Generally good sightlines throughout, comfortable seats.' },
  };
  const findings = detectBoilerplatePhrases(theaters);
  assert.ok(findings.some(f => f.type === 'boilerplate-phrase'));
});

test('detectBoilerplatePhrases: phrase in 2 theaters is fine (below threshold)', () => {
  const theaters = {
    'A Theatre': { summary: 'Offers generally good sightlines.' },
    'B Theatre': { summary: 'Generally good sightlines, tight seats.' },
  };
  assert.deepEqual(detectBoilerplatePhrases(theaters), []);
});

// ─── checkScoreDistribution ─────────────────────────────────────────────────

test('checkScoreDistribution: well-spread scores — no warnings', () => {
  const theaters = {};
  for (let i = 1; i <= 20; i++) {
    theaters[`Theatre ${i}`] = {
      sightlines: (i % 5) + 1,
      sound: (i % 4) + 1,
      comfort: (i % 5) + 1,
      ambiance: (i % 3) + 1,
      facilities: (i % 4) + 1,
    };
  }
  const { warnings } = checkScoreDistribution(theaters);
  assert.ok(!warnings.some(w => w.type === 'score-clustering'));
});

test('checkScoreDistribution: 80% same value triggers clustering warning', () => {
  const theaters = {};
  for (let i = 1; i <= 10; i++) {
    theaters[`Theatre ${i}`] = {
      sightlines: i <= 8 ? 4 : 3, // 80% are 4
      sound: 3, comfort: 2, ambiance: 4, facilities: 3,
    };
  }
  const { warnings } = checkScoreDistribution(theaters);
  assert.ok(warnings.some(w => w.type === 'score-clustering' && w.dimension === 'sightlines'));
});

// ─── validateVenueScores (integration) ──────────────────────────────────────

test('validateVenueScores: clean theater passes all checks', () => {
  const vs = {
    sightlines: 4,
    sound: 3,
    comfort: 2,
    ambiance: 5,
    facilities: 2,
    summary: 'Stunning Tiffany ceiling but notoriously tight legroom. Restrooms can get very crowded at intermission.',
  };
  assert.deepEqual(validateVenueScores('Test Theatre', vs), []);
});

test('validateVenueScores: Todd Haimes original summary fails', () => {
  // Golden fixture: the exact summary that triggered this eval
  const vs = {
    sightlines: 4, sound: 4, comfort: 4, ambiance: 4, facilities: 4,
    summary: 'Completed a major renovation in early 2026 with all seats replaced, legroom expanded, new restrooms, and elevator access to all levels. One of Broadway\'s most accessible and comfortable houses thanks to the recent upgrades.',
  };
  const findings = validateVenueScores('Todd Haimes Theatre', vs);
  assert.ok(findings.some(f => f.type === 'banned-claim' && f.matched && f.matched.toLowerCase().includes('elevator')));
  assert.ok(findings.some(f => f.type === 'banned-claim' && f.matched && f.matched.toLowerCase().includes('accessible')));
});
